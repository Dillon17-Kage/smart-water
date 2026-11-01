namespace SmartWater.Api.Database;

/// <summary>
/// Reads a .env-style file (KEY=value per line). The Neon CLI (`neon deploy`,
/// `neon env pull`) writes DATABASE_URL into .env.local at the repo root, and
/// Git ignores that file, so the connection string never gets committed.
/// </summary>
public static class EnvFile
{
    public static Dictionary<string, string> Read(string path)
    {
        var values = new Dictionary<string, string>();
        if (!File.Exists(path)) return values;

        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;

            int equals = line.IndexOf('=');
            if (equals <= 0) continue;

            string key = line[..equals].Trim();
            string value = line[(equals + 1)..].Trim().Trim('"', '\'');
            values[key] = value;
        }
        return values;
    }

    /// <summary>Looks for the file in this folder and every parent folder.</summary>
    public static string? Find(string startFolder, string fileName)
    {
        for (var folder = new DirectoryInfo(startFolder); folder is not null; folder = folder.Parent)
        {
            string candidate = Path.Combine(folder.FullName, fileName);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}
