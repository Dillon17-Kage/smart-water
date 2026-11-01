// Runs SQL files from db/ against the Neon branch in .env.local, without needing psql.
//
//   cd tools\dbsetup
//   dotnet run                                              shows what's in the database
//   dotnet run -- ..\..\db\001_schema.sql ..\..\db\002_seed.sql   runs the files in order
//   dotnet run -- adduser alice operator "Alice Smith"         creates or updates a login (asks for the password)
//
// It uses DATABASE_URL_UNPOOLED, the direct connection: Neon recommends a direct
// (not pooled) connection for schema changes. Which branch that is depends on the
// last `neon deploy` / `neon env pull` / `neon checkout`.
//
// Each db/ file has its own BEGIN ... COMMIT, so a file that fails changes nothing.
// psql-only commands (\set, \echo in db/tests) aren't supported here.

using Npgsql;
using SmartWater.Api.Database;

string? envPath = EnvFile.Find(Directory.GetCurrentDirectory(), ".env.local");
var env = envPath is null ? new Dictionary<string, string>() : EnvFile.Read(envPath);
string? url = Environment.GetEnvironmentVariable("DATABASE_URL_UNPOOLED")
              ?? env.GetValueOrDefault("DATABASE_URL_UNPOOLED");
if (url is null)
{
    Console.WriteLine("No DATABASE_URL_UNPOOLED found. In the repo root, run: npx neon@latest env pull");
    return 1;
}

var settings = new NpgsqlConnectionStringBuilder(DatabaseUrl.ToNpgsql(url));
string branch = env.GetValueOrDefault("NEON_BRANCH", "?");
Console.WriteLine($"Neon branch {branch}, host {settings.Host}, database {settings.Database} (direct connection)");

await using var connection = new NpgsqlConnection(settings.ConnectionString);
await connection.OpenAsync();

// dotnet run -- adduser <username> <role> ["Full Name"]
// Asks for the password here, so it never ends up in Git or in the shell history.
// Running it again for an existing username changes their password and role.
if (args.Length >= 3 && args[0] == "adduser")
{
    string username = args[1], role = args[2];
    string? fullName = args.Length > 3 ? args[3] : null;
    string password = ReadHidden($"Password for {username}: ");
    if (password.Length < 8 || password != ReadHidden("Again: "))
    {
        Console.WriteLine("Passwords didn't match, or shorter than 8 characters. Nothing changed.");
        return 1;
    }

    await using var upsert = new NpgsqlCommand("""
        INSERT INTO users (role_id, username, full_name, password_hash)
        SELECT id, @username, @fullName, @hash FROM roles WHERE name = @role
        ON CONFLICT (username) DO UPDATE
            SET role_id = EXCLUDED.role_id, full_name = COALESCE(EXCLUDED.full_name, users.full_name),
                password_hash = EXCLUDED.password_hash, failed_logins = 0, locked_until = NULL, active = true
        """, connection);
    upsert.Parameters.AddWithValue("username", username);
    upsert.Parameters.AddWithValue("fullName", (object?)fullName ?? DBNull.Value);
    upsert.Parameters.AddWithValue("hash", BCrypt.Net.BCrypt.HashPassword(password));
    upsert.Parameters.AddWithValue("role", role);
    bool saved = await upsert.ExecuteNonQueryAsync() == 1;
    Console.WriteLine(saved
        ? $"Saved {username} ({role})."
        : $"No role called '{role}'. Use administrator, operator, technician or engineer.");
    return saved ? 0 : 1;
}

foreach (string file in args)
{
    Console.Write($"Running {Path.GetFileName(file)} ... ");
    try
    {
        await using var command = new NpgsqlCommand(await File.ReadAllTextAsync(file), connection);
        await command.ExecuteNonQueryAsync();
        Console.WriteLine("done");
    }
    catch (PostgresException ex)
    {
        Console.WriteLine($"FAILED: {ex.MessageText}");
        Console.WriteLine("Nothing in that file was applied. Later files were skipped.");
        return 1;
    }
}

// Always finish by showing what's there, as a check.
await using (var check = new NpgsqlCommand(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sensors')", connection))
{
    if (!(bool)(await check.ExecuteScalarAsync())!)
    {
        Console.WriteLine("The database is empty (no tables yet).");
        return 0;
    }
}

Console.WriteLine();
Console.WriteLine("Sensors:");
await using (var sensors = new NpgsqlCommand("""
    SELECT s.code, s.type, s.position, z.code, n.name, s.gpio_pin, s.active
    FROM sensors s JOIN nodes n ON n.id = s.node_id LEFT JOIN zones z ON z.id = s.zone_id
    ORDER BY s.type, s.code
    """, connection))
await using (var reader = await sensors.ExecuteReaderAsync())
{
    while (await reader.ReadAsync())
        Console.WriteLine($"  {reader.GetString(0),-4} {reader.GetString(1),-9} {reader.GetString(2),-12} zone {(reader.IsDBNull(3) ? "-" : reader.GetString(3))}  {reader.GetString(4)}  GPIO {reader.GetInt16(5),2}  {(reader.GetBoolean(6) ? "active" : "inactive")}");
}

await using (var valves = new NpgsqlCommand(
    "SELECT v.code, n.name, v.gpio_pin FROM valves v JOIN nodes n ON n.id = v.node_id ORDER BY v.code", connection))
await using (var reader = await valves.ExecuteReaderAsync())
{
    Console.WriteLine("Valves:");
    while (await reader.ReadAsync())
        Console.WriteLine($"  {reader.GetString(0)}  {reader.GetString(1)}  GPIO {reader.GetInt16(2)}");
}

await using (var interlock = new NpgsqlCommand(
    "SELECT value FROM settings WHERE key = 'valve.interlock_min_open_zones'", connection))
{
    Console.WriteLine($"Valve interlock (min open zones): {await interlock.ExecuteScalarAsync()}");
}
return 0;

// Reads a line without showing it. Falls back to plain input when typing is piped in.
static string ReadHidden(string prompt)
{
    Console.Write(prompt);
    if (Console.IsInputRedirected) return Console.ReadLine() ?? "";
    var text = new System.Text.StringBuilder();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.Enter) break;
        if (key.Key == ConsoleKey.Backspace) { if (text.Length > 0) text.Length--; }
        else if (!char.IsControl(key.KeyChar)) text.Append(key.KeyChar);
    }
    Console.WriteLine();
    return text.ToString();
}
