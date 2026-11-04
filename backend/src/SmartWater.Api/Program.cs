// Smart Water backend.
//
// Serves the React web app, the HTTP API (Api/Endpoints.cs) and the live SignalR hub
// (/hubs/live), and runs the services that talk to the nodes over MQTT:
//   Mqtt/MqttConnection      the connection to the broker (EMQX)
//   Ingestion/ReadingsIngestion  checks, converts and stores readings
//   Nodes/NodeMonitor        online / offline, heartbeat timeout
//   Detection/LeakDetector   per-zone mass balance -> leak events
//   Alerts/AlertService      alerts for leaks, offline nodes, failed valves
//   Valves/ValveControl      valve commands, interlock, ack and timeout
//   Auth/AuthService         login with lockout, JWT tokens

using System.Security.Cryptography;
using System.Text;
using Dapper;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.FileProviders;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using SmartWater.Api.Alerts;
using SmartWater.Api.Api;
using SmartWater.Api.Auth;
using SmartWater.Api.Database;
using SmartWater.Api.Detection;
using SmartWater.Api.Ingestion;
using SmartWater.Api.Live;
using SmartWater.Api.Mqtt;
using SmartWater.Api.Nodes;
using SmartWater.Api.Rig;
using SmartWater.Api.Valves;

var builder = WebApplication.CreateBuilder(args);

// Render tells the app which port to listen on through the PORT variable.
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrEmpty(port))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

// The Neon connection string comes from the environment, never from Git:
//   locally:  `neon deploy` / `neon env pull` write DATABASE_URL into .env.local
//             at the repo root (Git ignores it), and we read it from there
//   Render:   environment variable DATABASE_URL
// The app uses the pooled connection (DATABASE_URL): many short queries from a
// long-running server. Schema changes use DATABASE_URL_UNPOOLED (tools/dbsetup).
// ConnectionStrings:Default (user-secrets) still works and wins if set.
if (builder.Environment.IsDevelopment()
    && EnvFile.Find(builder.Environment.ContentRootPath, ".env.local") is { } envFile)
{
    // Real environment variables and user-secrets keep priority over the file.
    var fromFile = EnvFile.Read(envFile)
        .Where(pair => builder.Configuration[pair.Key] is null)
        .Select(pair => new KeyValuePair<string, string?>(pair.Key, pair.Value));
    builder.Configuration.AddInMemoryCollection(fromFile);
}

var connectionString = builder.Configuration.GetConnectionString("Default") ?? builder.Configuration["DATABASE_URL"];
if (string.IsNullOrWhiteSpace(connectionString))
{
    throw new InvalidOperationException("No database configured. Set DATABASE_URL (see docs/setup.md section 1).");
}
builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(DatabaseUrl.ToNpgsql(connectionString)));
DefaultTypeMap.MatchNamesWithUnderscores = true;   // Dapper: column node_id fills property NodeId

// ---------------------------------------------------------------- sign-in (JWT)
// The key that signs login tokens. On Render it's Jwt__Key (render.yaml generates one).
// Locally a random key per run is fine: restarting the backend just means logging in again.
var jwtKey = builder.Configuration["Jwt:Key"] ?? Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
var signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey));
builder.Services.AddSingleton<SecurityKey>(signingKey);
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.MapInboundClaims = false;   // keep the claim names short: sub, name, role
        options.TokenValidationParameters = new TokenValidationParameters
        {
            IssuerSigningKey = signingKey,
            ValidateIssuer = false,
            ValidateAudience = false,
            NameClaimType = "name",
            RoleClaimType = "role",
        };
        // Browsers can't set headers on a WebSocket, so SignalR sends the token in the URL.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                if (context.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                    context.Token = context.Request.Query["access_token"];
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();
builder.Services.AddSignalR();

// ---------------------------------------------------------------- services
// Singletons: each keeps state (the rig cache, open leaks, the MQTT connection) for the app's lifetime.
builder.Services.AddSingleton<RigCache>();
builder.Services.AddSingleton<LivePush>();
builder.Services.AddSingleton<AlertService>();
builder.Services.AddSingleton<AuthService>();
builder.Services.AddSingleton<LeakIndicator>();
builder.Services.AddSingleton<LeakDetector>();
builder.Services.AddSingleton<ValveControl>();
builder.Services.AddSingleton<ReadingsIngestion>();
builder.Services.AddSingleton<NodeMonitor>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<NodeMonitor>());
builder.Services.AddSingleton<MqttConnection>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<MqttConnection>());

var app = builder.Build();

// Load the rig configuration before any message arrives.
await app.Services.GetRequiredService<RigCache>().ReloadAsync();

// ---------------------------------------------------------------- web app files
// In production the Dockerfile copies web/dist into wwwroot.
// In development "WebRoot" points at ../../../web/dist, so `npm run build`
// in web/ followed by `dotnet run` serves the whole system on one address.
var webRoot = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, app.Configuration["WebRoot"] ?? "wwwroot"));
var hasWebApp = File.Exists(Path.Combine(webRoot, "index.html"));
if (hasWebApp)
{
    var files = new PhysicalFileProvider(webRoot);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = files });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = files });
}

app.UseAuthentication();
app.UseAuthorization();

// ---------------------------------------------------------------- API
var startedAt = DateTimeOffset.UtcNow;

// Render calls this to check the service is up. It also reports whether the
// database and the broker are reachable: the first things to check after deploying.
app.MapGet("/api/health", async (NpgsqlDataSource db, MqttConnection mqtt, CancellationToken ct) =>
{
    string database;
    string? schema = null;
    try
    {
        await using var cmd = db.CreateCommand(
            "SELECT (SELECT count(*) FROM zones WHERE active) || ' active zone(s), ' || (SELECT count(*) FROM sensors WHERE active) || ' sensor(s)'");
        schema = (string?)await cmd.ExecuteScalarAsync(ct);
        database = "ok";
    }
    catch (Exception ex)
    {
        database = $"error: {ex.Message}";
    }

    // The service itself is healthy even if the database isn't; the body says which.
    return Results.Ok(new
    {
        status = "ok",
        database,
        mqtt = mqtt.IsConnected ? "connected" : "not connected",
        rig = schema,
        webApp = hasWebApp ? "served" : "not built",
        startedAt,
    });
});

app.MapSmartWaterApi();
app.MapHub<LiveHub>("/hubs/live");

// Unknown /api paths are a 404, not the web app.
app.Map("/api/{**rest}", () => Results.NotFound(new { message = "Unknown API endpoint" }));

// ---------------------------------------------------------------- client-side routes
// /alerts, /valves and so on are React routes: send index.html and let the app route.
if (hasWebApp)
{
    app.MapFallback(async context =>
    {
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.SendFileAsync(Path.Combine(webRoot, "index.html"));
    });
}
else
{
    app.MapGet("/", () => Results.Text(
        "Smart Water API is running. The web app isn't built: run `npm run build` in web/, then restart.",
        "text/plain"));
}

app.Run();
