using Npgsql;

namespace SmartWater.Api.Database;

/// <summary>
/// Neon hands out connection strings as URLs:
///   postgresql://user:password@ep-xxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&amp;channel_binding=require
/// Npgsql wants "Host=...;Username=...;Password=..." instead. This converts one to the other,
/// so DATABASE_URL can be pasted exactly as Neon gives it.
/// </summary>
public static class DatabaseUrl
{
    public static string ToNpgsql(string value)
    {
        // Already in Npgsql's own format (e.g. copied from Neon's ".NET" tab): use it as it is.
        if (!value.StartsWith("postgres://") && !value.StartsWith("postgresql://")) return value;

        var uri = new Uri(value);
        string[] user = uri.UserInfo.Split(':', 2);

        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = uri.Host,
            Port = uri.Port > 0 ? uri.Port : 5432,
            Database = uri.AbsolutePath.TrimStart('/'),
            Username = Uri.UnescapeDataString(user[0]),
            Password = user.Length > 1 ? Uri.UnescapeDataString(user[1]) : null,
            SslMode = SslMode.Require,   // Neon only accepts encrypted connections
        };

        foreach (string pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            string[] parts = pair.Split('=', 2);
            string setting = parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "";
            switch (parts[0])
            {
                case "sslmode":          // require, verify-full, ...
                    builder.SslMode = Enum.Parse<SslMode>(setting.Replace("-", ""), ignoreCase: true);
                    break;
                case "channel_binding":  // require: protects the password exchange
                    builder.ChannelBinding = Enum.Parse<ChannelBinding>(setting, ignoreCase: true);
                    break;
            }
        }
        return builder.ConnectionString;
    }
}
