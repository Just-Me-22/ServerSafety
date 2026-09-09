/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { GuildStore, RestAPI, SnowflakeUtils, UserStore } from "@webpack/common";

import { openGuildSafetyModal } from "./SafetyModal";

const CONFIG_KEY = "serverSafety-watchRules-config";
const SEEN_KEY = "serverSafety-watchRules-seen";
const CHECK_EVERY = 300_000;

export interface Rule {
    key: string;
    label: string;
}

/** watched as messages and joins arrive, so these are immediate rather than polled */
export const LIVE: Rule[] = [
    { key: "spikes", label: "a channel floods" },
    { key: "newcomers", label: "a new account posts a link or invite" },
    { key: "rejoins", label: "someone kicked or banned here comes back" },
    { key: "firstpost", label: "someone who joined today says their first thing" }
];

/** read out of the audit log every few minutes. each one is a shape rather than a
 *  single action type, which is why they are hand written. */
export const RULES: Rule[] = [
    { key: "admin", label: "a role gains Administrator" },
    { key: "power", label: "a role gains Manage Server, Roles, Channels or Webhooks" },
    { key: "webhook", label: "a webhook is created" },
    { key: "gate", label: "verification or media scanning is lowered" },
    { key: "prune", label: "members are pruned" },
    { key: "ban", label: "someone is banned by anyone but me" }
];

export type RuleConfig = Record<string, string[]>;

let watched: RuleConfig = {};

export const rulesFor = (guildId: string): string[] => watched[guildId] ?? [];

export async function setRules(guildId: string, keys: string[]) {
    watched = { ...watched, [guildId]: keys };
    await DataStore.set(CONFIG_KEY, watched);
}

const POWER = ["MANAGE_GUILD", "MANAGE_ROLES", "MANAGE_CHANNELS", "MANAGE_WEBHOOKS"] as const;

const BITS: Record<string, bigint> = {
    ADMINISTRATOR: 8n,
    MANAGE_GUILD: 32n,
    MANAGE_ROLES: 268435456n,
    MANAGE_CHANNELS: 16n,
    MANAGE_WEBHOOKS: 536870912n
};

const enum Action {
    GuildUpdate = 1,
    Prune = 21,
    Ban = 22,
    RoleCreate = 30,
    RoleUpdate = 31,
    WebhookCreate = 50
}

interface Change { key: string; old_value?: any; new_value?: any; }
interface Entry {
    id: string;
    action_type: number;
    user_id: string | null;
    target_id: string | null;
    changes?: Change[];
}

const asBits = (value: unknown) => {
    try {
        return BigInt((value as string | number) ?? 0);
    } catch {
        return 0n;
    }
};

function why(entry: Entry, keys: string[], me: string): string | null {
    const find = (key: string) => entry.changes?.find(change => change.key === key);

    if (entry.action_type === Action.RoleCreate || entry.action_type === Action.RoleUpdate) {
        const perms = find("permissions") ?? find("permissions_new");
        if (perms) {
            const before = asBits(perms.old_value);
            const after = asBits(perms.new_value);
            const gained = after & ~before;

            if (keys.includes("admin") && (gained & BITS.ADMINISTRATOR) === BITS.ADMINISTRATOR) {
                return "a role just gained Administrator";
            }
            if (keys.includes("power")) {
                const got = POWER.filter(name => (gained & BITS[name]) === BITS[name]);
                if (got.length) return `a role just gained ${got.map(one => one.toLowerCase().replace(/_/g, " ")).join(", ")}`;
            }
        }
    }

    if (keys.includes("webhook") && entry.action_type === Action.WebhookCreate) return "a webhook was created";
    if (keys.includes("prune") && entry.action_type === Action.Prune) return "members were pruned";
    if (keys.includes("ban") && entry.action_type === Action.Ban && entry.user_id !== me) return "someone was banned";

    if (keys.includes("gate") && entry.action_type === Action.GuildUpdate) {
        const verification = find("verification_level");
        if (verification && Number(verification.new_value) < Number(verification.old_value)) return "verification was lowered";

        const filter = find("explicit_content_filter");
        if (filter && Number(filter.new_value) < Number(filter.old_value)) return "media scanning was loosened";
    }

    return null;
}

/** the newest entry id already reported per guild, so a reload does not replay
 *  everything that happened while you were away */
const readSeen = async () => (await DataStore.get<Record<string, string>>(SEEN_KEY)) ?? {};

async function sweep() {
    const seen = await readSeen();
    let changed = false;

    for (const [guildId, keys] of Object.entries(watched)) {
        if (!keys.some(key => RULES.some(rule => rule.key === key))) continue;

        const guild = GuildStore.getGuild(guildId);
        if (!guild) continue;

        let entries: Entry[];
        try {
            const { body } = await RestAPI.get({ url: `/guilds/${guildId}/audit-logs`, query: { limit: "50" } });
            entries = (body.audit_log_entries ?? []) as Entry[];
        } catch {
            continue;
        }

        const last = seen[guildId];
        const fresh = last ? entries.filter(entry => entry.id > last) : entries.slice(0, 1);

        if (entries.length) {
            seen[guildId] = entries[0].id;
            changed = true;
        }

        // a first run has nothing to compare against, so it only marks its place
        if (!last) continue;

        const me = UserStore.getCurrentUser()?.id ?? "";
        const hits = fresh
            .map(entry => ({ entry, reason: why(entry, keys, me) }))
            .filter(one => one.reason != null);

        for (const hit of hits.slice(0, 3)) {
            showNotification({
                title: `${guild.name}: ${hit.reason}`,
                body: new Date(SnowflakeUtils.extractTimestamp(hit.entry.id)).toLocaleTimeString(),
                onClick: () => openGuildSafetyModal(guild)
            });
        }
    }

    if (changed) await DataStore.set(SEEN_KEY, seen);
}

let timer = 0;

export function startWatchRules() {
    void DataStore.get<RuleConfig>(CONFIG_KEY).then(found => {
        watched = found ?? {};
        void sweep();
    });
    timer = window.setInterval(sweep, CHECK_EVERY);
}

export function stopWatchRules() {
    clearInterval(timer);
    timer = 0;
}
