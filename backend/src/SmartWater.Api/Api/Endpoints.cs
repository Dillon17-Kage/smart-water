using Dapper;
using Npgsql;
using SmartWater.Api.Alerts;
using SmartWater.Api.Auth;
using SmartWater.Api.Detection;
using SmartWater.Api.Live;
using SmartWater.Api.Rig;
using SmartWater.Api.Valves;

namespace SmartWater.Api.Api;

/// <summary>
/// The HTTP API used by web/src/data/api/apiSource.ts. Who may do what follows
/// web/src/auth/permissions.ts; the browser hides buttons, but this is where it's enforced.
/// </summary>
public static class Endpoints
{
    // Roles allowed to do each thing (permissions.ts).
    private static readonly string[] Operators = ["administrator", "operator"];
    private static readonly string[] Acknowledgers = ["administrator", "operator", "technician"];
    private static readonly string[] Calibrators = ["administrator", "technician"];

    public record LoginRequest(string Username, string Password);
    public record ValveCommandRequest(string Action, bool Force = false);

    public static void MapSmartWaterApi(this WebApplication app)
    {
        app.MapPost("/api/auth/login", async (LoginRequest request, AuthService auth) =>
        {
            var result = await auth.LoginAsync(request.Username ?? "", request.Password ?? "");
            return result.User is null
                ? Results.Json(new { message = result.Message }, statusCode: result.StatusCode)
                : Results.Ok(new { user = result.User, token = result.Token });
        });

        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/rig", (RigCache rig) => new
        {
            zones = rig.Zones,
            nodes = rig.Nodes.Select(n => n.ToDto()),
            sensors = rig.Sensors.Where(s => s.Active),
            valves = rig.Valves,
            baselines = rig.Baselines,
            settings = rig.Detection,
        });

        api.MapGet("/readings/recent", async (int? seconds, NpgsqlDataSource db) =>
        {
            int window = Math.Clamp(seconds ?? 300, 1, 3600);
            await using var connection = await db.OpenConnectionAsync();
            return await connection.QueryAsync<ReadingDto>(
                """
                SELECT sensor_id AS SensorId, recorded_at AS RecordedAt, value AS Value FROM readings
                WHERE recorded_at > now() - make_interval(secs => @window)
                ORDER BY recorded_at
                """, new { window });
        });

        api.MapGet("/alerts", (AlertService alerts) => alerts.RecentAsync());
        api.MapGet("/leak-events", (LeakDetector detector) => detector.RecentAsync());
        api.MapGet("/valve-commands", (ValveControl valves) => valves.RecentAsync());

        api.MapPost("/alerts/{id:int}/acknowledge", async (int id, HttpContext http, AlertService alerts) =>
                await alerts.AcknowledgeAsync(id, AuthService.UserId(http.User)) is { } alert ? Results.Ok(alert) : Results.NotFound())
            .RequireAuthorization(p => p.RequireRole(Acknowledgers));

        api.MapPost("/alerts/{id:int}/resolve", async (int id, HttpContext http, AlertService alerts) =>
                await alerts.ResolveAsync(id, AuthService.UserId(http.User)) is { } alert ? Results.Ok(alert) : Results.NotFound())
            .RequireAuthorization(p => p.RequireRole(Operators));

        // A refused command (node offline, interlock) is still a 200: the command was
        // recorded, with status "rejected" and the reason (source.ts: "not an error").
        api.MapPost("/valves/{id:int}/commands", async (short id, ValveCommandRequest request, HttpContext http, ValveControl valves) =>
            {
                if (request.Action is not ("open" or "close"))
                    return Results.BadRequest(new { message = "action must be open or close" });
                var command = await valves.SendAsync(id, request.Action, request.Force, AuthService.UserId(http.User));
                return command is null ? Results.NotFound(new { message = "No such valve" }) : Results.Ok(command);
            })
            .RequireAuthorization(p => p.RequireRole(Operators));

        // ---- Calibration ------------------------------------------------------------
        // Baseline: with every leak point shut and water flowing, records the normal
        // inlet - outlet mismatch of the zone's two flow sensors over the last 60 s.
        api.MapPost("/zones/{id:int}/baseline", async (short id, HttpContext http, NpgsqlDataSource db, RigCache rig) =>
            {
                var inlet = rig.Sensors.FirstOrDefault(s => s.ZoneId == id && s.Type == "flow" && s.Position == "zone_inlet" && s.Active);
                var outlet = rig.Sensors.FirstOrDefault(s => s.ZoneId == id && s.Type == "flow" && s.Position == "zone_outlet" && s.Active);
                var pressure = rig.Sensors.FirstOrDefault(s => s.ZoneId == id && s.Type == "pressure" && s.Position == "zone_inlet" && s.Active);
                if (inlet is null || outlet is null)
                    return Results.BadRequest(new { message = "This zone doesn't have both flow sensors" });

                await using var connection = await db.OpenConnectionAsync();
                var stats = await connection.QuerySingleAsync<(long Samples, double? InletFlow, double? OutletFlow, double? Offset, double? Spread, double? Pressure)>(
                    """
                    SELECT count(*), avg(fi.value), avg(fo.value), avg(fi.value - fo.value),
                           coalesce(stddev_samp(fi.value - fo.value), 0),
                           (SELECT avg(value) FROM readings WHERE sensor_id = @pressureId AND recorded_at > now() - interval '60 seconds')
                    FROM readings fi
                    JOIN readings fo ON fo.sensor_id = @outletId AND fo.recorded_at = fi.recorded_at
                    WHERE fi.sensor_id = @inletId AND fi.recorded_at > now() - interval '60 seconds'
                    """, new { inletId = inlet.Id, outletId = outlet.Id, pressureId = pressure?.Id ?? -1 });
                if (stats.Samples < 30)
                    return Results.BadRequest(new { message = $"Only {stats.Samples} readings in the last 60 s. Run water through the zone for a minute first." });
                if (stats.InletFlow < 0.1)
                    return Results.BadRequest(new { message = "No flow through the zone. Switch the pump on and open the valve first." });

                await connection.ExecuteAsync(
                    """
                    UPDATE baselines SET is_current = false WHERE zone_id = @id AND is_current;
                    INSERT INTO baselines (zone_id, inlet_flow, outlet_flow, flow_offset, flow_offset_stddev,
                                           inlet_pressure, outlet_pressure, sample_window_s, recorded_by)
                    VALUES (@id, @InletFlow, @OutletFlow, @Offset, @Spread, coalesce(@Pressure, 0), 0, 60, @userId);
                    """,
                    // outlet_pressure is 0: there's no outlet pressure sensor on this rig.
                    new { id, stats.InletFlow, stats.OutletFlow, stats.Offset, stats.Spread, stats.Pressure, userId = AuthService.UserId(http.User) });
                await rig.ReloadAsync();
                return Results.Ok(rig.Baseline(id));
            })
            .RequireAuthorization(p => p.RequireRole(Calibrators));

        // Pressure zero: with the pump off (no pressure), the sensor's average voltage over
        // the last 10 s becomes its zero point (cal_offset), so it reads 0 kPa.
        api.MapPost("/sensors/{id:int}/zero", async (short id, HttpContext http, NpgsqlDataSource db, RigCache rig) =>
            {
                var sensor = rig.Sensors.FirstOrDefault(s => s.Id == id && s.Type == "pressure");
                if (sensor is null) return Results.BadRequest(new { message = "Only pressure sensors can be zeroed" });

                await using var connection = await db.OpenConnectionAsync();
                var (samples, volts) = await connection.QuerySingleAsync<(long, double?)>(
                    "SELECT count(*), avg(raw_value) FROM readings WHERE sensor_id = @id AND recorded_at > now() - interval '10 seconds'",
                    new { id });
                if (samples < 5 || volts is null)
                    return Results.BadRequest(new { message = "Not enough recent readings. Is the node online?" });

                await connection.ExecuteAsync(
                    """
                    UPDATE sensors SET cal_offset = @volts WHERE id = @id;
                    INSERT INTO maintenance (sensor_id, performed_by, kind, description)
                    VALUES (@id, @userId, 'calibration', 'Pressure zero set to ' || round(@volts::numeric, 3) || ' V');
                    """, new { id, volts, userId = AuthService.UserId(http.User) });
                await rig.ReloadAsync();
                return Results.Ok(new { sensor = sensor.Code, zeroVolts = volts });
            })
            .RequireAuthorization(p => p.RequireRole(Calibrators));
    }
}
