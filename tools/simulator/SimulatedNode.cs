// A pretend node-2 with F1 (trunk flow), F8 (return flow) and Zone A: F2 (inlet flow),
// F3 (outlet flow), P1 (inlet pressure) and SV1 (normally closed solenoid). It behaves like the firmware
// described in docs/mqtt-contract.md, but makes up the water physics.
//
// This class has no MQTT code: it builds the messages and handles commands,
// and Program.cs sends and receives them. That keeps the rules easy to read.

namespace SmartWater.Simulator;

public class SimulatedNode
{
    // ---- Rig numbers (docs/hardware-brief.md) --------------------------------
    const double KFactor = 98;              // YF-S401: 98 pulses per second per L/min
    const double PressureOffsetV = 0.5;     // 100 PSI transducer: 0.5 V at 0 kPa...
    const double PressureScaleKpaPerV = 172.37; // ...and 172.37 kPa per volt above that
    const double NormalFlowLpm = 0.65;      // Zone A runs at about 0.6-0.7 L/min
    const double NormalPressureKpa = 60;
    const double OutletSensorError = 0.015; // F3 reads 1.5 % low, like two cheap sensors that never agree exactly
    const string Firmware = "sim-1.0.0";

    public string Name { get; }
    public string FlowIn { get; }
    public string FlowOut { get; }
    public string? FlowTrunk { get; }    // F1 and F8 are only on node-2, with Zone A
    public string? FlowReturn { get; }
    public string PressureIn { get; }
    public string Valve { get; }

    // ---- What the keyboard controls ------------------------------------------
    public bool PumpOn { get; set; } = true;
    public bool LeakOpen { get; set; }
    public double LeakLpm { get; set; } = 0.35;     // how far the drain cock is open
    public bool ValveFault { get; set; }            // the node ignores commands, so the backend times out
    public bool SendTimestamps { get; set; } = true; // false = pretend NTP hasn't synced
    public bool LastOpenValveCheck { get; set; } = true; // the firmware's config.h flag

    // ---- Node state ------------------------------------------------------------
    // The firmware opens every valve at boot (brief §5.5), so SV1 starts open.
    public bool ValveOpen { get; private set; } = true;
    long seq;
    long totalIn, totalOut, totalTrunk, totalReturn;
    double carryIn, carryOut, carryTrunk, carryReturn;   // fractions of a pulse left over from the last window
    readonly DateTime bootedAt = DateTime.UtcNow;
    readonly Random random = new();

    // Last 10 command ids and the ack we sent for each, so a duplicate delivery
    // gets the same answer and isn't acted on twice (contract §7).
    readonly Queue<(string Id, AckMessage Ack)> recentCommands = new();

    /// <param name="zone">A (node-2, with F1 and F8), B (node-3) or C (node-4): picks the sensor codes.</param>
    public SimulatedNode(string name, string zone = "A")
    {
        Name = name;
        (FlowIn, FlowOut, PressureIn, Valve) = zone.ToUpperInvariant() switch
        {
            "B" => ("F4", "F5", "P2", "SV2"),
            "C" => ("F6", "F7", "P3", "SV3"),
            _ => ("F2", "F3", "P1", "SV1"),
        };
        if (Valve == "SV1") (FlowTrunk, FlowReturn) = ("F1", "F8");
    }

    // ---- Physics -------------------------------------------------------------

    /// <summary>The true flows and pressure right now, before the sensors measure them.</summary>
    public (double InLpm, double OutLpm, double Kpa) TrueValues()
    {
        // Pump off, or SV1 closed upstream of everything: no flow, no pressure at P1.
        if (!PumpOn || !ValveOpen) return (0, 0, 0);

        double leak = LeakOpen ? LeakLpm : 0;
        // An open drain cock lowers the resistance, so a little more water comes in,
        // but the leak itself never reaches F3.
        double inlet = NormalFlowLpm + 0.3 * leak;
        double outlet = inlet - leak;
        double kpa = NormalPressureKpa - 10 * leak;
        return (inlet, outlet, kpa);
    }

    /// <summary>Builds one readings message for a window of <paramref name="intervalMs"/> (contract §4).</summary>
    public ReadingsMessage Measure(int intervalMs)
    {
        var (inLpm, outLpm, kpa) = TrueValues();
        double seconds = intervalMs / 1000.0;

        // Sensor noise of about ±1 %, plus F3's steady error.
        inLpm *= 1 + Noise(0.01);
        outLpm *= (1 - OutletSensorError) * (1 + Noise(0.01));

        long pulsesIn = CountPulses(inLpm, seconds, ref carryIn);
        long pulsesOut = CountPulses(outLpm, seconds, ref carryOut);
        totalIn += pulsesIn;
        totalOut += pulsesOut;

        // Zone A is the only zone, so the trunk carries what enters it and the return
        // carries what leaves it. Each sensor has its own noise.
        var (trueIn, trueOut, _) = TrueValues();
        long pulsesTrunk = CountPulses(trueIn * (1 + Noise(0.01)), seconds, ref carryTrunk);
        long pulsesReturn = CountPulses(trueOut * (1 + Noise(0.01)), seconds, ref carryReturn);
        totalTrunk += pulsesTrunk;
        totalReturn += pulsesReturn;

        // The firmware sends the sensor's own voltage in mV (contract §4).
        double volts = PressureOffsetV + Math.Max(0, kpa + Noise(0.5)) / PressureScaleKpaPerV;

        return new ReadingsMessage(
            Node: Name,
            Seq: seq++,
            Ts: SendTimestamps ? DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") : null,
            IntervalMs: intervalMs,
            Flow: FlowTrunk is null || FlowReturn is null
                ? [new(FlowIn, pulsesIn, totalIn), new(FlowOut, pulsesOut, totalOut)]
                :
                [
                    new(FlowTrunk, pulsesTrunk, totalTrunk),
                    new(FlowIn, pulsesIn, totalIn),
                    new(FlowOut, pulsesOut, totalOut),
                    new(FlowReturn, pulsesReturn, totalReturn),
                ],
            Pressure: [new(PressureIn, (int)Math.Round(volts * 1000))],
            Valves: [new(Valve, ValveState)]);
    }

    static long CountPulses(double lpm, double seconds, ref double carry)
    {
        // Real sensors only produce whole pulses; keep the fraction for the next window.
        double exact = lpm * KFactor * seconds + carry;
        long whole = (long)Math.Floor(exact);
        carry = exact - whole;
        return whole;
    }

    double Noise(double size) => (random.NextDouble() * 2 - 1) * size;

    public string ValveState => ValveOpen ? "open" : "closed";

    public StatusMessage Status() => new(
        Node: Name,
        State: "online",
        Fw: Firmware,
        Mac: "02:00:00:00:00:02",
        Ip: "127.0.0.1",
        Rssi: -55 + random.Next(-3, 4),
        UptimeS: (long)(DateTime.UtcNow - bootedAt).TotalSeconds,
        Heap: 180000 + random.Next(0, 4000),
        Ntp: SendTimestamps);

    public StatusMessage OfflineWill() => new(Node: Name, State: "offline");

    // ---- Valve commands (contract §6-§7) -------------------------------------

    /// <summary>
    /// Handles one command. Returns the ack to publish, or null when the valve
    /// fault is switched on (the node stays silent and the backend times out).
    /// </summary>
    public AckMessage? HandleCommand(CommandMessage? cmd)
    {
        if (ValveFault) return null;

        string id = cmd?.Id ?? "";
        string valve = cmd?.Valve ?? "";

        var repeat = recentCommands.FirstOrDefault(c => c.Id == id && id != "");
        if (repeat.Ack is not null) return repeat.Ack;

        AckMessage ack = Decide(cmd, id, valve);
        if (id != "")
        {
            recentCommands.Enqueue((id, ack));
            if (recentCommands.Count > 10) recentCommands.Dequeue();
        }
        return ack;
    }

    AckMessage Decide(CommandMessage? cmd, string id, string valve)
    {
        AckMessage Rejected(string reason, string state) => new(id, valve, "rejected", state, reason);
        AckMessage Done() => new(id, valve, "done", ValveState, null);

        if (cmd is null || id == "" || cmd.Action is not ("open" or "close"))
            return Rejected("bad_command", valve == Valve ? ValveState : "unknown");
        if (valve != Valve)
            return Rejected("unknown_valve", "unknown");

        bool wantOpen = cmd.Action == "open";
        if (wantOpen == ValveOpen) return Done();   // already there: nothing to do

        // This node has one valve, so closing it always leaves none open on the node.
        // Only a forced close gets through: the backend sends force when its rig-wide
        // interlock allowed it (other zones open, or the operator confirmed the pump is off).
        if (!wantOpen && LastOpenValveCheck && cmd.Force != true)
            return Rejected("last_open_valve", ValveState);

        ValveOpen = wantOpen;
        return Done();
    }

    /// <summary>For the console: true values as the backend should show them.</summary>
    public string Describe()
    {
        var (inLpm, outLpm, kpa) = TrueValues();
        return $"{FlowIn} {inLpm:0.00} L/min | {FlowOut} {outLpm:0.00} L/min | {PressureIn} {kpa:0} kPa | {Valve} {ValveState} | " +
               $"pump {(PumpOn ? "on" : "OFF")} | leak {(LeakOpen ? $"OPEN {LeakLpm:0.00} L/min" : $"shut (set {LeakLpm:0.00})")}" +
               (ValveFault ? " | VALVE FAULT" : "") + (SendTimestamps ? "" : " | no NTP");
    }
}
