using System.Security.Claims;
using Dapper;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using SmartWater.Api.Rig;

namespace SmartWater.Api.Auth;

/// <summary>Shaped like User in web/src/types.ts.</summary>
public sealed record UserDto(int Id, string Username, string? FullName, string Role);

public sealed record LoginResult(int StatusCode, string? Message, UserDto? User = null, string? Token = null);

/// <summary>
/// Login (activity diagram 10.1): check the password against its BCrypt hash, lock the
/// account after auth.max_failed_logins (5) wrong passwords for auth.lockout_minutes (15),
/// and hand out a signed token (JWT) that says who the user is and what role they have.
/// </summary>
public sealed class AuthService(NpgsqlDataSource db, RigCache rig, SecurityKey signingKey)
{
    public static readonly TimeSpan TokenLifetime = TimeSpan.FromHours(12);

    private sealed class UserRow
    {
        public int Id { get; init; }
        public string Username { get; init; } = "";
        public string? FullName { get; init; }
        public string PasswordHash { get; init; } = "";
        public bool Active { get; init; }
        public short FailedLogins { get; init; }
        public DateTime? LockedUntil { get; init; }
        public string Role { get; init; } = "";
    }

    public async Task<LoginResult> LoginAsync(string username, string password)
    {
        const string wrong = "Incorrect username or password.";
        await using var connection = await db.OpenConnectionAsync();
        var user = await connection.QuerySingleOrDefaultAsync<UserRow>(
            """
            SELECT u.id, u.username, u.full_name, u.password_hash, u.active, u.failed_logins, u.locked_until, r.name AS role
            FROM users u JOIN roles r ON r.id = u.role_id
            WHERE lower(u.username) = lower(@username)
            """, new { username });

        // Same message for "no such user" and "wrong password", so it doesn't reveal which usernames exist.
        if (user is null || !user.Active) return new(401, wrong);

        if (user.LockedUntil > DateTime.UtcNow)
            return new(423, $"This account is locked after too many failed attempts. Try again in {Math.Ceiling((user.LockedUntil.Value - DateTime.UtcNow).TotalMinutes):0} minutes.");

        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
        {
            int maxFailed = (int)rig.Setting("auth.max_failed_logins", 5);
            double lockMinutes = rig.Setting("auth.lockout_minutes", 15);
            // A lock that has run out starts the count again.
            int failed = (user.LockedUntil is null ? user.FailedLogins : 0) + 1;
            bool lockNow = failed >= maxFailed;
            await connection.ExecuteAsync(
                """
                UPDATE users SET failed_logins = @failed,
                       locked_until = CASE WHEN @lockNow THEN now() + make_interval(mins => @minutes) END
                WHERE id = @Id
                """, new { failed = lockNow ? 0 : failed, lockNow, minutes = (int)lockMinutes, user.Id });
            return lockNow
                ? new(423, $"Too many failed attempts. The account is locked for {lockMinutes:0} minutes.")
                : new(401, wrong);
        }

        await connection.ExecuteAsync(
            "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = @Id", new { user.Id });
        var dto = new UserDto(user.Id, user.Username, user.FullName, user.Role);
        return new(200, null, dto, CreateToken(dto));
    }

    private string CreateToken(UserDto user) =>
        new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Subject = new ClaimsIdentity([
                new Claim("sub", user.Id.ToString()),
                new Claim("name", user.Username),
                new Claim("role", user.Role),
            ]),
            Expires = DateTime.UtcNow.Add(TokenLifetime),
            SigningCredentials = new SigningCredentials(signingKey, SecurityAlgorithms.HmacSha256),
        });

    /// <summary>The signed-in user's id, from the token.</summary>
    public static int UserId(ClaimsPrincipal principal) => int.Parse(principal.FindFirstValue("sub")!);
}
