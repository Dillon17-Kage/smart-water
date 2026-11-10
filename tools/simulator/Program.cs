// Smart Water node simulator: a fake node-2 that talks to the broker exactly
// like the ESP32 firmware (docs/mqtt-contract.md), so the backend and web app
// can be tested without the rig.
//
//   dotnet run                      uses the EMQX settings in user-secrets
//   dotnet run -- --Mqtt:Host=localhost --Mqtt:Port=1883 --Mqtt:UseTls=false
//   dotnet run -- --Node=node-3 --Zone=B    pretend to be node-3 with Zone B (C: node-4)
//
// Keys: see PrintHelp() below, or press H while it runs.

using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using MQTTnet;
using MQTTnet.Protocol;
using SmartWater.Simulator;

// ---- Settings ---------------------------------------------------------------
// EMQX host, username and password come from user-secrets (never Git):
//   dotnet user-secrets set "Mqtt:Host" "xxxx.ala.eu-central-1.emqxsl.com"
var config = new ConfigurationBuilder()
    .AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.json"), optional: true)
    .AddUserSecrets<SimulatedNode>(optional: true)
    .AddCommandLine(args)
    .Build();

string host = config["Mqtt:Host"] ?? "";
int port = int.Parse(config["Mqtt:Port"] ?? "8883");
bool useTls = bool.Parse(config["Mqtt:UseTls"] ?? "true");
string nodeName = config["Node"] ?? "node-2";

if (host == "")
{
    Console.WriteLine("No broker set. Run once in this folder:");
    Console.WriteLine("  dotnet user-secrets set \"Mqtt:Host\" \"<your-deployment>.emqxsl.com\"");
    Console.WriteLine("  dotnet user-secrets set \"Mqtt:Username\" \"<node-2 username>\"");
    Console.WriteLine("  dotnet user-secrets set \"Mqtt:Password\" \"<node-2 password>\"");
    Console.WriteLine("See docs/setup.md.");
    return 1;
}

var node = new SimulatedNode(nodeName, config["Zone"] ?? "A");
string topic(string kind) => $"smartwater/{nodeName}/{kind}";

// ---- MQTT -------------------------------------------------------------------
var client = new MqttClientFactory().CreateMqttClient();

var options = new MqttClientOptionsBuilder()
    .WithTcpServer(host, port)
    .WithClientId(config["Mqtt:ClientId"] ?? $"sw-{nodeName}")   // same id as the real board: run one or the other
    .WithCredentials(config["Mqtt:Username"], config["Mqtt:Password"])
    .WithProtocolVersion(MQTTnet.Formatter.MqttProtocolVersion.V500)
    .WithCleanSession(true)
    .WithKeepAlivePeriod(TimeSpan.FromSeconds(15))
    // Last will: the broker publishes this if we vanish without saying goodbye.
    .WithWillTopic(topic("status"))
    .WithWillPayload(Json.Write(node.OfflineWill()))
    .WithWillQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
    .WithWillRetain(true);
if (useTls) options.WithTlsOptions(tls => tls.UseTls());
var clientOptions = options.Build();

bool wantOnline = true;   // false while the "node offline" key is active

async Task Publish(string kind, string payload, bool retain = false)
{
    if (!client.IsConnected) return;
    var message = new MqttApplicationMessageBuilder()
        .WithTopic(topic(kind))
        .WithPayload(payload)
        .WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)
        .WithRetainFlag(retain)
        .Build();
    try { await client.PublishAsync(message); }
    catch (Exception ex) { Log($"publish {kind} failed: {ex.Message}"); }
}

client.ApplicationMessageReceivedAsync += async e =>
{
    string payload = e.ApplicationMessage.ConvertPayloadToString() ?? "";

    // The real node drives its LEDs from this (contract §9). Here we just show it.
    if (e.ApplicationMessage.Topic == topic("indicator"))
    {
        Log($"indicator {payload}");
        return;
    }

    CommandMessage? cmd = null;
    try { cmd = JsonSerializer.Deserialize<CommandMessage>(payload, Json.Options); }
    catch (JsonException) { /* bad JSON: answered as bad_command below */ }

    AckMessage? ack = node.HandleCommand(cmd);
    if (ack is null)
    {
        Log($"cmd {payload}  ->  IGNORED (valve fault on, the backend should time out)");
        return;
    }
    Log($"cmd {payload}  ->  {ack.Result}{(ack.Reason is null ? "" : $" ({ack.Reason})")}, {ack.Valve} {ack.State}");
    await Publish("ack", JsonSerializer.Serialize(ack, Json.KeepNulls));
};

async Task Connect()
{
    await client.ConnectAsync(clientOptions);
    // Clean session: subscribe again after every connect (contract §1).
    await client.SubscribeAsync(new MqttClientSubscribeOptionsBuilder()
        .WithTopicFilter(f => f.WithTopic(topic("cmd")).WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce))
        .WithTopicFilter(f => f.WithTopic(topic("indicator")).WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce))
        .Build());
    // Replace the retained "offline" will straight away (contract §5).
    await Publish("status", Json.Write(node.Status()), retain: true);
    Log($"connected to {host}:{port} as {clientOptions.ClientId}");
}

// Keep trying to stay connected, backing off up to 30 s, like the firmware.
var connectionLoop = Task.Run(async () =>
{
    var delay = TimeSpan.FromSeconds(1);
    while (true)
    {
        if (wantOnline && !client.IsConnected)
        {
            try { await Connect(); delay = TimeSpan.FromSeconds(1); }
            catch (Exception ex)
            {
                Log($"connect failed: {ex.Message}. Retrying in {delay.TotalSeconds:0} s");
                await Task.Delay(delay);
                delay = TimeSpan.FromSeconds(Math.Min(30, delay.TotalSeconds * 2));
                continue;
            }
        }
        await Task.Delay(500);
    }
});

// ---- Timers: readings every second, status every 10 s ------------------------
var readingsLoop = Task.Run(async () =>
{
    var window = Stopwatch.StartNew();
    var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
    int tick = 0;
    while (await timer.WaitForNextTickAsync())
    {
        // Measure the real window length, as the firmware does with millis().
        int intervalMs = (int)window.ElapsedMilliseconds;
        window.Restart();

        // The node keeps measuring while offline (the totals keep counting);
        // those windows' messages are simply never sent.
        var readings = node.Measure(intervalMs);
        await Publish("readings", Json.Write(readings));

        if (++tick % 10 == 0) await Publish("status", Json.Write(node.Status()), retain: true);
        if (tick % 5 == 0) Log(node.Describe() + (client.IsConnected ? "" : " | NOT CONNECTED"));
    }
});

// ---- Keyboard ---------------------------------------------------------------
PrintHelp();
Log(node.Describe());

while (true)
{
    char key = ReadKey();
    switch (key)
    {
        case 'l':
            node.LeakOpen = !node.LeakOpen;
            Log(node.LeakOpen ? $"Drain cock OPENED: {node.LeakLpm:0.00} L/min leaving Zone A between F2 and F3" : "Drain cock shut");
            break;
        case '+' or '=':
            node.LeakLpm = Math.Min(0.6, node.LeakLpm + 0.05);
            Log($"Leak size {node.LeakLpm:0.00} L/min");
            break;
        case '-' or '_':
            node.LeakLpm = Math.Max(0.05, node.LeakLpm - 0.05);
            Log($"Leak size {node.LeakLpm:0.00} L/min");
            break;
        case 'p':
            node.PumpOn = !node.PumpOn;
            Log(node.PumpOn ? "Pump ON" : "Pump OFF");
            break;
        case 'o':
            wantOnline = !wantOnline;
            if (!wantOnline)
            {
                // Like pulling the plug on the Wi-Fi. MQTT 5 lets us ask the broker
                // to publish the last will now instead of after the keep-alive.
                await client.DisconnectAsync(new MqttClientDisconnectOptionsBuilder()
                    .WithReason(MqttClientDisconnectOptionsReason.DisconnectWithWillMessage).Build());
                Log("Node OFFLINE (last will sent). Press O again to reconnect");
            }
            else Log("Reconnecting...");
            break;
        case 'f':
            node.ValveFault = !node.ValveFault;
            Log(node.ValveFault ? "Valve fault ON: commands are ignored, no ack, so the backend times out" : "Valve fault off");
            break;
        case 'i':
            node.LastOpenValveCheck = !node.LastOpenValveCheck;
            Log($"Node's last-open-valve check {(node.LastOpenValveCheck ? "ON" : "OFF")}");
            break;
        case 't':
            node.SendTimestamps = !node.SendTimestamps;
            Log(node.SendTimestamps ? "Sending timestamps (NTP synced)" : "No timestamps (NTP not synced): the backend uses receive time");
            break;
        case 's':
            Log(node.Describe() + (client.IsConnected ? " | MQTT ok" : " | NOT CONNECTED"));
            break;
        case 'h' or '?':
            PrintHelp();
            break;
        case 'q':
            // A clean goodbye: publish "offline" ourselves, then disconnect normally.
            await Publish("status", Json.Write(node.OfflineWill()), retain: true);
            await client.DisconnectAsync();
            return 0;
    }
}

// Reads one key. When input is piped in (automated tests), reads one character
// per line, and quits when the input ends.
static char ReadKey()
{
    if (!Console.IsInputRedirected) return char.ToLowerInvariant(Console.ReadKey(intercept: true).KeyChar);
    string? line = Console.ReadLine();
    if (line is null) return 'q';
    return line.Length > 0 ? char.ToLowerInvariant(line[0]) : ' ';
}

static void PrintHelp() => Console.WriteLine("""

    Smart Water node simulator (fake node-2, Zone A)
      L      open / shut the drain cock (the leak)
      + / -  leak size up / down by 0.05 L/min (0.05 to 0.60)
      P      pump on / off
      O      node offline / back online (sends the last will)
      F      valve fault: ignore commands so the backend times out
      I      node's last-open-valve check on / off
      T      timestamps on / off (pretend NTP hasn't synced)
      S      show the current state
      H      this help
      Q      quit

    """);

static void Log(string text) => Console.WriteLine($"{DateTime.Now:HH:mm:ss}  {text}");
