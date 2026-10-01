import type { Client } from "discord.js";

export async function resolveUserLabels(client: Client, discordUserIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = [...new Set(discordUserIds)];
  const entries = await Promise.all(ids.map(async (id) => {
    const user = await client.users.fetch(id).catch(() => null);
    if (!user) return [id, null] as const;
    const label = user.globalName && user.globalName !== user.username ? `${user.globalName} (@${user.username})` : `@${user.username}`;
    return [id, label] as const;
  }));
  return new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}
