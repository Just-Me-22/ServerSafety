/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, SnowflakeUtils } from "@webpack/common";

import { openMemberPowerModal } from "./MemberPower";

const KEY = "serverInfo-watchlist";

/** how many messages in one channel inside the window counts as a flood */
const WINDOW = 10_000;
const SPIKE = 25;
/** one alert per channel or per person in this long, so a real flood does not
 *  become a flood of notifications */
const COOLDOWN = 120_000;

const FRESH_JOIN = 10 * 60_000;
const FRESH_ACCOUNT = 86_400_000;
const LINK = /discord\.gg\/|discord\.com\/invite\/|https?:\/\//i;

let watched = new Set<string>();
let spikes = () => false;
let newcomers = () => false;

const recent = new Map<string, number[]>();
const lastAlert = new Map<string, number>();

export const isWatched = (userId: string) => watched.has(userId);

export async function loadWatchlist() {
    watched = new Set(await DataStore.get<string[]>(KEY) ?? []);
}

export async function toggleWatch(userId: string) {
    if (watched.has(userId)) watched.delete(userId);
    else watched.add(userId);

    await DataStore.set(KEY, [...watched]);
    return watched.has(userId);
}

function once(key: string) {
    const now = Date.now();
    if (now - (lastAlert.get(key) ?? 0) < COOLDOWN) return false;

    if (lastAlert.size > 500) {
        for (const [old, when] of lastAlert) if (now - when > COOLDOWN) lastAlert.delete(old);
    }

    lastAlert.set(key, now);
    return true;
}

function tell(guildId: string, userId: string | null, title: string, body: string) {
    showNotification({
        title,
        body,
        onClick: () => {
            const guild = GuildStore.getGuild(guildId);
            if (guild && userId) openMemberPowerModal(guild, userId);
        }
    });
}

function onMessage({ guildId, channelId, message, optimistic }: {
    guildId?: string;
    channelId: string;
    message?: { author?: { id: string; username: string; bot?: boolean; }; content?: string; };
    optimistic?: boolean;
}) {
    if (optimistic || !guildId) return;
    if (!watched.size && !spikes() && !newcomers()) return;

    const author = message?.author;
    if (!author || author.bot) return;

    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    const where = ChannelStore.getChannel(channelId)?.name ?? "a channel";

    if (watched.has(author.id) && once(`watch:${author.id}`)) {
        tell(guildId, author.id, `${author.username} is talking in ${guild.name}`, `In #${where}. You asked to be told.`);
    }

    if (spikes()) {
        const now = Date.now();
        const times = (recent.get(channelId) ?? []).filter(time => now - time < WINDOW);
        times.push(now);
        recent.set(channelId, times);

        if (recent.size > 200) {
            for (const [old, stamps] of recent) if (!stamps.length || now - stamps[stamps.length - 1] > WINDOW) recent.delete(old);
        }

        if (times.length >= SPIKE && once(`spike:${channelId}`)) {
            tell(guildId, null, `#${where} is flooding`, `${times.length} messages in the last ten seconds in ${guild.name}.`);
        }
    }

    if (newcomers() && LINK.test(message?.content ?? "")) {
        const joinedAt = (GuildMemberStore.getMember(guildId, author.id) as any)?.joinedAt;
        const isNewHere = joinedAt != null && Date.now() - new Date(joinedAt).getTime() < FRESH_JOIN;
        const isNewAccount = Date.now() - SnowflakeUtils.extractTimestamp(author.id) < FRESH_ACCOUNT;

        if ((isNewHere || isNewAccount) && once(`new:${author.id}`)) {
            tell(
                guildId,
                author.id,
                `A new account posted a link in ${guild.name}`,
                `${author.username} in #${where}, ${isNewHere ? "joined minutes ago" : "account made today"}.`
            );
        }
    }
}

export function startWatchers(onSpikes: () => boolean, onNewcomers: () => boolean) {
    spikes = onSpikes;
    newcomers = onNewcomers;

    void loadWatchlist();
    FluxDispatcher.subscribe("MESSAGE_CREATE" as any, onMessage as any);
}

export function stopWatchers() {
    FluxDispatcher.unsubscribe("MESSAGE_CREATE" as any, onMessage as any);
    recent.clear();
    lastAlert.clear();
    watched.clear();
}
