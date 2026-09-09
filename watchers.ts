/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, SnowflakeUtils } from "@webpack/common";

import { slowDown } from "./autoSlow";
import { lookUp } from "./departures";
import { openMemberPowerModal } from "./MemberPower";
import { noteJoin } from "./raidGuard";

const KEY = "serverInfo-watchlist";

/** how many messages in one channel inside the window counts as a flood, for the
 *  notification. auto slowmode carries its own threshold, set per server. */
const WINDOW = 10_000;
const SPIKE = 25;
/** timestamps are kept this long so both thresholds can be measured off one list */
const KEEP = 120_000;
/** one alert per channel or per person in this long, so a real flood does not
 *  become a flood of notifications */
const COOLDOWN = 120_000;

const FRESH_JOIN = 10 * 60_000;
const FRESH_ACCOUNT = 86_400_000;
const LINK = /discord\.gg\/|discord\.com\/invite\/|https?:\/\//i;

/** how new a member has to be for their first message here to be worth a look */
const NEW_MEMBER = 86_400_000;

interface Switches {
    spikes: (guildId: string) => boolean;
    newcomers: (guildId: string) => boolean;
    rejoins: (guildId: string) => boolean;
    firstPost: (guildId: string) => boolean;
    autoSlow: (guildId: string) => { count: number; window: number; seconds: number; minutes: number; } | null;
}

let watched = new Set<string>();
let on: Switches = {
    spikes: () => false,
    newcomers: () => false,
    rejoins: () => false,
    firstPost: () => false,
    autoSlow: () => null
};

/** who has already said something here, so the first one is the only one reported.
 *  memory only: a restart forgetting means at worst one extra notification. */
let spoken = new Set<string>();

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
    if (!watched.size && !on.spikes(guildId) && !on.newcomers(guildId) && !on.firstPost(guildId) && !on.autoSlow(guildId)) return;

    const author = message?.author;
    if (!author || author.bot) return;

    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    const where = ChannelStore.getChannel(channelId)?.name ?? "a channel";

    if (watched.has(author.id) && once(`watch:${author.id}`)) {
        tell(guildId, author.id, `${author.username} is talking in ${guild.name}`, `In #${where}. You asked to be told.`);
    }

    // the counting has to run for either of them: the notification and the slowmode
    // are separate switches, and turning one on should not need the other
    const auto = on.autoSlow(guildId);

    if (on.spikes(guildId) || auto) {
        const now = Date.now();
        const times = (recent.get(channelId) ?? []).filter(time => now - time < KEEP);
        times.push(now);
        recent.set(channelId, times);

        if (recent.size > 200) {
            for (const [old, stamps] of recent) if (!stamps.length || now - stamps[stamps.length - 1] > KEEP) recent.delete(old);
        }

        const within = (ms: number) => times.reduce((count, time) => now - time < ms ? count + 1 : count, 0);

        if (on.spikes(guildId) && within(WINDOW) >= SPIKE && once(`spike:${channelId}`)) {
            tell(guildId, null, `#${where} is flooding`, `${within(WINDOW)} messages in the last ten seconds in ${guild.name}.`);
        }

        // its own cooldown key, so silencing the notification cannot silence the action
        if (auto && within(auto.window * 1000) >= auto.count && once(`slow:${channelId}`)) {
            void slowDown(guildId, guild.name, channelId, auto.seconds, auto.minutes);
        }
    }

    if (on.firstPost(guildId)) {
        const key = `${guildId}:${author.id}`;

        if (!spoken.has(key)) {
            if (spoken.size > 5000) spoken = new Set();
            spoken.add(key);

            const joinedAt = (GuildMemberStore.getMember(guildId, author.id) as any)?.joinedAt;
            const fresh = joinedAt != null && Date.now() - new Date(joinedAt).getTime() < NEW_MEMBER;

            if (fresh) {
                tell(
                    guildId,
                    author.id,
                    `${author.username} just said their first thing in ${guild.name}`,
                    `In #${where}. ${(message?.content ?? "").slice(0, 120) || "No text, an attachment or embed."}`
                );
            }
        }
    }

    if (on.newcomers(guildId) && LINK.test(message?.content ?? "")) {
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

// the gateway sends guild_id and a member object, and flux does not rename either of
// those consistently across the events it forwards, so read whichever arrived
async function onJoin(action: any) {
    const guildId: string | undefined = action.guildId ?? action.guild_id;
    const user = action.user ?? action.member?.user;
    if (!guildId || !user?.id) return;

    void noteJoin(guildId);
    if (!on.rejoins(guildId)) return;

    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    const before = await lookUp(guildId, user.id);
    if (!before || !once(`rejoin:${user.id}`)) return;

    tell(
        guildId,
        user.id,
        `${user.username} is back in ${guild.name}`,
        `${before.kind === "ban" ? "Banned" : "Kicked"} here on ${new Date(before.at).toLocaleDateString()}${before.by ? ` by ${before.by}` : ""}.`
    );
}

export function startWatchers(switches: Switches) {
    on = switches;

    void loadWatchlist();
    FluxDispatcher.subscribe("MESSAGE_CREATE" as any, onMessage as any);
    FluxDispatcher.subscribe("GUILD_MEMBER_ADD", onJoin);
}

export function stopWatchers() {
    FluxDispatcher.unsubscribe("MESSAGE_CREATE" as any, onMessage as any);
    FluxDispatcher.unsubscribe("GUILD_MEMBER_ADD", onJoin);
    recent.clear();
    lastAlert.clear();
    watched.clear();
    spoken.clear();
}
