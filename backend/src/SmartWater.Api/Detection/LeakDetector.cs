using Dapper;
using Npgsql;
using SmartWater.Api.Alerts;
using SmartWater.Api.Live;
using SmartWater.Api.Rig;

namespace SmartWater.Api.Detection;

/// <summary>Shaped like LeakEvent in web/src/types.ts.</summary>
public sealed class LeakEventDto
{
    public int Id { get; init; }
    public short? ZoneId { get; init; }
    public string Status { get; init; } = "";
    public DateTime DetectedAt { get; init; }
    public DateTime? ConfirmedAt { get; init; }
    public DateTime? ResolvedAt { get; init; }
    public double PeakResidual { get; init; }
    public double LossRate { get; init; }
    public double VolumeLost { get; init; }
    public double PressureDrop { get; init; }
}

/// <summary>
/// Per-zone mass balance. Each second, for every zone with both flow sensors:
///
///   residual = inlet flow - outlet flow - baseline offset
///
/// Water that goes in but doesn't come out is leaking. The steps:
///   residual above threshold          -> leak event "suspected"
///   still above after confirm period  -> "confirmed", critical alert
///   drops back before confirmation    -> "false_alarm" (pump start, valve moving)
///   below threshold for clear period  -> "resolved"
/// While a leak is open it tracks the loss rate, peak, litres lost and pressure drop.
/// </summary>
public sealed class LeakDetector(NpgsqlDataSource db, RigCache rig, AlertService alerts, LivePush live,
    ILogger<LeakDetector> log)
{
    private const string Select = """
        SELECT id, zone_id, status, detected_at, confirmed_at, resolved_at,
               COALESCE(peak_residual, 0) AS peak_residual, COALESCE(loss_rate, 0) AS loss_rate,
               volume_lost, COALESCE(pressure_drop, 0) AS pressure_drop
        FROM leak_events
        """;

    // What detection remembers about each zone between messages.
    private sealed class ZoneState
    {
        public int? EventId;              // the open (suspected or confirmed) leak event
        public bool Confirmed;
        public DateTime AboveSince;       // when the residual went over the threshold
        public DateTime? BelowSince;      // when it dropped back under, while an event is open
        public double Peak;
        public double Volume;             // litres
    }

    private readonly Dictionary<short, ZoneState> zones = [];
    private bool loadedOpenEvents;

    public async Task<IEnumerable<LeakEventDto>> RecentAsync()
    {
        await using var connection = await db.OpenConnectionAsync();
        return await connection.QueryAsync<LeakEventDto>($"{Select} ORDER BY detected_at DESC LIMIT 100");
    }

    /// <param name="values">This message's converted values, by sensor id.</param>
    public async Task AnalyseAsync(DateTime at, double seconds, IReadOnlyDictionary<short, double> values)
    {
        if (!loadedOpenEvents) await LoadOpenEventsAsync();
        var settings = rig.Detection;

        foreach (var zone in rig.Zones.Where(z => z.Active))
        {
            var inlet = ZoneSensor(zone.Id, "flow", "zone_inlet");
            var outlet = ZoneSensor(zone.Id, "flow", "zone_outlet");
            if (inlet is null || outlet is null) continue;
            if (!values.TryGetValue(inlet.Id, out double inFlow) || !values.TryGetValue(outlet.Id, out double outFlow)) continue;

            var baseline = rig.Baseline(zone.Id);
            double residual = inFlow - outFlow - (baseline?.FlowOffset ?? 0);
            double? pressureDrop = null;
            var pressureSensor = ZoneSensor(zone.Id, "pressure", "zone_inlet");
            if (baseline is not null && pressureSensor is not null && values.TryGetValue(pressureSensor.Id, out double kpa))
                pressureDrop = baseline.InletPressure - kpa;

            var state = zones.TryGetValue(zone.Id, out var s) ? s : zones[zone.Id] = new ZoneState();
            bool above = residual > settings.ResidualThreshold;

            if (state.EventId is null)
            {
                if (above) await StartAsync(zone, state, at, residual, pressureDrop, baseline);
                continue;
            }

            // An event is open: keep its figures up to date.
            state.Peak = Math.Max(state.Peak, residual);
            if (above) state.Volume += residual * seconds / 60;   // L/min over `seconds`
            state.BelowSince = above ? null : state.BelowSince ?? at;

            if (!state.Confirmed && above && at - state.AboveSince >= TimeSpan.FromSeconds(settings.ConfirmSeconds))
            {
                await ConfirmAsync(zone, state, at, residual, pressureDrop);
            }
            else if (!state.Confirmed && !above)
            {
                await CloseAsync(state, at, "false_alarm");
                log.LogInformation("Zone {Zone}: residual back to normal before confirmation (false alarm)", zone.Code);
            }
            else if (state.Confirmed && state.BelowSince is { } since && at - since >= TimeSpan.FromSeconds(settings.ClearSeconds))
            {
                await CloseAsync(state, at, "resolved");
                log.LogInformation("Zone {Zone}: leak resolved", zone.Code);
            }
            else
            {
                await UpdateAsync(state, above ? residual : 0, pressureDrop);
            }
        }
    }

    private SensorRow? ZoneSensor(short zoneId, string type, string position) =>
        rig.Sensors.FirstOrDefault(s => s.ZoneId == zoneId && s.Type == type && s.Position == position && s.Active);

    private async Task StartAsync(ZoneRow zone, ZoneState state, DateTime at, double residual, double? pressureDrop, BaselineRow? baseline)
    {
        await using var connection = await db.OpenConnectionAsync();
        state.EventId = await connection.QuerySingleAsync<int>(
            """
            INSERT INTO leak_events (zone_id, status, detected_at, peak_residual, loss_rate, pressure_drop, baseline_id)
            VALUES (@zoneId, 'suspected', @at, @residual, @residual, @pressureDrop, @baselineId)
            RETURNING id
            """, new { zoneId = zone.Id, at, residual, pressureDrop, baselineId = baseline?.Id });
        state.Confirmed = false;
        state.AboveSince = at;
        state.BelowSince = null;
        state.Peak = residual;
        state.Volume = 0;
        log.LogInformation("Zone {Zone}: possible leak, residual {Residual:0.00} L/min", zone.Code, residual);
        await PushAsync(connection, state.EventId.Value);
    }

    private async Task ConfirmAsync(ZoneRow zone, ZoneState state, DateTime at, double residual, double? pressureDrop)
    {
        state.Confirmed = true;
        await using (var connection = await db.OpenConnectionAsync())
        {
            await connection.ExecuteAsync(
                """
                UPDATE leak_events SET status = 'confirmed', confirmed_at = @at, peak_residual = @Peak,
                       loss_rate = @residual, volume_lost = @Volume, pressure_drop = COALESCE(@pressureDrop, pressure_drop)
                WHERE id = @id
                """, new { at, state.Peak, residual, state.Volume, pressureDrop, id = state.EventId });
            await PushAsync(connection, state.EventId!.Value);
        }
        log.LogWarning("Zone {Zone}: LEAK CONFIRMED, losing {Residual:0.00} L/min", zone.Code, residual);
        await alerts.RaiseAsync("leak", "critical",
            $"Leak in {zone.Name}: about {residual:0.00} L/min going in that doesn't come out. Close the zone's valve to isolate it.",
            leakEventId: state.EventId);
    }

    private async Task UpdateAsync(ZoneState state, double lossRate, double? pressureDrop)
    {
        await using var connection = await db.OpenConnectionAsync();
        await connection.ExecuteAsync(
            """
            UPDATE leak_events SET peak_residual = @Peak, loss_rate = @lossRate, volume_lost = @Volume,
                   pressure_drop = COALESCE(@pressureDrop, pressure_drop)
            WHERE id = @id
            """, new { state.Peak, lossRate, state.Volume, pressureDrop, id = state.EventId });
        await PushAsync(connection, state.EventId!.Value);
    }

    private async Task CloseAsync(ZoneState state, DateTime at, string status)
    {
        await using var connection = await db.OpenConnectionAsync();
        await connection.ExecuteAsync(
            "UPDATE leak_events SET status = @status, resolved_at = @at, loss_rate = 0, volume_lost = @Volume WHERE id = @id",
            new { status, at, state.Volume, id = state.EventId });
        await PushAsync(connection, state.EventId!.Value);
        state.EventId = null;
        state.Confirmed = false;
        state.BelowSince = null;
    }

    private async Task PushAsync(NpgsqlConnection connection, int id) =>
        await live.LeakEventChanged(await connection.QuerySingleAsync<LeakEventDto>($"{Select} WHERE id = @id", new { id }));

    // After a restart, pick up leaks that were still open so they aren't duplicated.
    private async Task LoadOpenEventsAsync()
    {
        await using var connection = await db.OpenConnectionAsync();
        var open = await connection.QueryAsync<LeakEventDto>($"{Select} WHERE status IN ('suspected', 'confirmed')");
        foreach (var e in open.Where(e => e.ZoneId is not null))
        {
            zones[e.ZoneId!.Value] = new ZoneState
            {
                EventId = e.Id,
                Confirmed = e.Status == "confirmed",
                AboveSince = e.DetectedAt,
                Peak = e.PeakResidual,
                Volume = e.VolumeLost,
            };
        }
        loadedOpenEvents = true;
    }
}
