using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace SmartWater.Api.Live;

/// <summary>
/// SignalR hub at /hubs/live. The browser only listens; the services push to it through
/// <see cref="LivePush"/>. Message names match web/src/data/api/apiSource.ts.
/// </summary>
[Authorize]
public sealed class LiveHub : Hub;

/// <summary>Sends live updates to every signed-in browser.</summary>
public sealed class LivePush(IHubContext<LiveHub> hub)
{
    public Task Readings(IEnumerable<ReadingDto> readings) => hub.Clients.All.SendAsync("Readings", readings);
    public Task NodeChanged(object node) => hub.Clients.All.SendAsync("NodeChanged", node);
    public Task ValveChanged(object valve) => hub.Clients.All.SendAsync("ValveChanged", valve);
    public Task ValveCommandChanged(object command) => hub.Clients.All.SendAsync("ValveCommandChanged", command);
    public Task AlertChanged(object alert) => hub.Clients.All.SendAsync("AlertChanged", alert);
    public Task LeakEventChanged(object leakEvent) => hub.Clients.All.SendAsync("LeakEventChanged", leakEvent);
}

public sealed record ReadingDto(short SensorId, DateTime RecordedAt, double Value);
