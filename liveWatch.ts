/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { FluxDispatcher, GuildStore, IconUtils } from "@webpack/common";

import { openGuildSafetyModal } from "./SafetyModal";
import { criticalTitles } from "./SafetyTab";
import { alertChannel, postTo } from "./send";

/** a permission edit arrives as a burst of events, so wait for the burst to end */
const SETTLE = 1500;
const SEED_AFTER = 8000;

const seen = new Map<string, Set<string>>();
const pending = new Map<string, number>();

let enabled = () => true;
let seedTimer = 0;

function check(guildId: string) {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    const now = new Set(criticalTitles(guild));
    const before = seen.get(guildId);
    seen.set(guildId, now);

    if (!before) return;

    const appeared = [...now].filter(title => !before.has(title));
    if (!appeared.length) return;

    showNotification({
        title: `${guild.name}: ${appeared.length === 1 ? "a new critical problem" : `${appeared.length} new critical problems`}`,
        body: appeared.join("\n"),
        icon: guild.icon
            ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: false, size: 128 })
            : undefined,
        onClick: () => openGuildSafetyModal(guild)
    });

    void alertChannel(guild.id).then(channelId => {
        if (!channelId) return;

        const lines = appeared.map(title => `- ${title}`).join("\n");
        return postTo(guild, channelId, `**Server safety**\n${lines}`, "Posted a safety alert")
            .catch(() => { /* the channel is gone, or we lost the right to post in it */ });
    });
}

function queue(guildId?: string) {
    if (!guildId || !enabled()) return;

    clearTimeout(pending.get(guildId));
    pending.set(guildId, window.setTimeout(() => {
        pending.delete(guildId);
        check(guildId);
    }, SETTLE));
}

const onRole = ({ guildId }: { guildId: string; }) => queue(guildId);
const onGuild = ({ guild }: { guild: { id: string; }; }) => queue(guild?.id);
const onChannel = ({ channel }: { channel: { guild_id?: string; }; }) => queue(channel?.guild_id);
const onChannels = ({ channels }: { channels: { guild_id?: string; }[]; }) => {
    for (const id of new Set(channels?.map(c => c?.guild_id))) queue(id);
};

const events = {
    GUILD_ROLE_CREATE: onRole,
    GUILD_ROLE_UPDATE: onRole,
    GUILD_ROLE_DELETE: onRole,
    GUILD_UPDATE: onGuild,
    CHANNEL_CREATE: onChannel,
    CHANNEL_DELETE: onChannel,
    CHANNEL_UPDATES: onChannels
} as const;

export function startWatch(isEnabled: () => boolean) {
    enabled = isEnabled;

    for (const [event, handler] of Object.entries(events)) {
        FluxDispatcher.subscribe(event as any, handler as any);
    }

    seedTimer = window.setTimeout(() => {
        for (const guild of Object.values(GuildStore.getGuilds())) {
            if (!seen.has(guild.id)) seen.set(guild.id, new Set(criticalTitles(guild)));
        }
    }, SEED_AFTER);
}

export function stopWatch() {
    clearTimeout(seedTimer);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    seen.clear();

    for (const [event, handler] of Object.entries(events)) {
        FluxDispatcher.unsubscribe(event as any, handler as any);
    }
}
