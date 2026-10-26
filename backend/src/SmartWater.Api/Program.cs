// Smart Water backend.
//
// Phase 0 skeleton: serves the React web app and a health check that also
// confirms the database connection. The ingestion, detection, alert and
// control services, the API endpoints and the SignalR hub are added in Phase 3.

using Microsoft.Extensions.FileProviders;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

// Render tells the app which port to listen on through the PORT variable.
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrEmpty(port))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

// The Neon connection string comes from the environment, never from Git:
//   locally:  dotnet user-secrets set "ConnectionStrings:Default" "<Neon connection string>"
//   Render:   environment variable ConnectionStrings__Default
var connectionString = builder.Configuration.GetConnectionString("Default");
if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(connectionString));
}

var app = builder.Build();

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

// ---------------------------------------------------------------- API
var startedAt = DateTimeOffset.UtcNow;

// Render calls this to check the service is up. It also reports whether the
// database is reachable, which is the first thing to check after deploying.
app.MapGet("/api/health", async (IServiceProvider services, CancellationToken ct) =>
{
    var db = services.GetService<NpgsqlDataSource>();
    string database;
    string? schema = null;

    if (db is null)
    {
        database = "not configured";
    }
    else
    {
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
    }

    // The service itself is healthy even if the database isn't; the body says which.
    return Results.Ok(new
    {
        status = "ok",
        database,
        rig = schema,
        webApp = hasWebApp ? "served" : "not built",
        startedAt,
    });
});

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
