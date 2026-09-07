/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { Channel, Guild, Permissions, Role } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { Button, ChannelRouter, ChannelStore, GuildChannelStore, GuildRoleStore, PermissionsBits, RestAPI, ScrollerThin, Text, useEffect, useState } from "@webpack/common";

import { openAllServersModal } from "./AllServers";
import { AuditTrail } from "./AuditTrail";
import { openBroadcastModal } from "./Broadcast";
import { openBulkModal } from "./Bulk";
import { openEmergencyModal } from "./Emergency";
import { openHistoryModal } from "./HistoryModal";
import { openInspectModal } from "./Inspect";
import { openPurgeModal } from "./Purge";
import { openRecentJoinsModal } from "./RecentJoins";
import { openRoleDiffModal } from "./RoleDiff";

const GuildSettingsActions = findByPropsLazy("open", "selectRole", "updateGuild");

const cl = classNameFactory("vc-ss-");

const enum Level {
    Critical,
    Warning
}

/** where the setting behind a finding actually lives */
type Fix =
    | { kind: "roles"; roleId?: string; }
    | { kind: "channel"; id: string; name: string; }
    | { kind: "settings"; section: string; subsection?: string; label: string; };

interface Finding {
    level: Level;
    title: string;
    detail: string;
    fix?: Fix;
}

// selecting a role only makes sense when the finding is about exactly one
const roleFix = (matched: Role[]): Fix => ({ kind: "roles", roleId: matched.length === 1 ? matched[0].id : undefined });
const channelFix = (channel: { id: string; name: string; }): Fix => ({ kind: "channel", id: channel.id, name: channel.name });

// GuildSettingsActions.open takes (guildId, section, location, subsection) and the
// section names are identity strings. Discord rewrites MEMBER_VERIFICATION to
// SAFETY itself on community servers, so passing it is right either way.
const MODERATION: Fix = { kind: "settings", section: "MODERATION", label: "Open Moderation" };
const safetyFix = (subsection: string): Fix => ({ kind: "settings", section: "SAFETY", subsection, label: "Open Safety Setup" });

interface Reach {
    total: number;
    visible: string[];
    postable: string[];
}

interface Report {
    findings: Finding[];
    reach: Reach | null;
}

const VERIFICATION_LEVELS = ["None", "Low", "Medium", "High", "Highest"];

// PermissionsBits is a lazy webpack find, so these stay as names and are resolved
// inside the audit rather than when this module is evaluated
const EVERYONE_RULES: { perm: Permissions; level: Level; title: string; detail: string; }[] = [
    {
        perm: "ADMINISTRATOR",
        level: Level.Critical,
        title: "@everyone has Administrator",
        detail: "Administrator ignores every channel override, so nothing else you set here matters. Turn it off first."
    },
    {
        perm: "MANAGE_GUILD",
        level: Level.Critical,
        title: "@everyone has Manage Server",
        detail: "Anyone can rename the server, change its settings and add integrations."
    },
    {
        perm: "MANAGE_ROLES",
        level: Level.Critical,
        title: "@everyone has Manage Roles",
        detail: "Anyone can hand themselves and their friends any role below @everyone's own position."
    },
    {
        perm: "MANAGE_CHANNELS",
        level: Level.Critical,
        title: "@everyone has Manage Channels",
        detail: "Anyone can rename, reorder or delete channels."
    },
    {
        perm: "MANAGE_WEBHOOKS",
        level: Level.Critical,
        title: "@everyone has Manage Webhooks",
        detail: "A webhook posts under any name and avatar and keeps working after the person is banned. This is the usual raid route."
    },
    {
        perm: "BAN_MEMBERS",
        level: Level.Critical,
        title: "@everyone can ban members",
        detail: "One person can empty the server."
    },
    {
        perm: "KICK_MEMBERS",
        level: Level.Critical,
        title: "@everyone can kick members",
        detail: "Same as banning, just reversible."
    },
    {
        perm: "MODERATE_MEMBERS",
        level: Level.Critical,
        title: "@everyone can time members out",
        detail: "Anyone can silence anyone, including staff."
    },
    {
        perm: "MANAGE_MESSAGES",
        level: Level.Warning,
        title: "@everyone has Manage Messages",
        detail: "Anyone can delete anyone's messages, so a troll can remove the evidence on the way out."
    },
    {
        perm: "MENTION_EVERYONE",
        level: Level.Warning,
        title: "@everyone can ping @everyone",
        detail: "The most used troll button there is. Leave it to the roles that need it."
    },
    {
        perm: "MANAGE_GUILD_EXPRESSIONS",
        level: Level.Warning,
        title: "@everyone can manage emoji and stickers",
        detail: "Anyone can delete or replace the server's emoji."
    },
    {
        perm: "MOVE_MEMBERS",
        level: Level.Warning,
        title: "@everyone can move members between voice channels",
        detail: "Anyone can drag people out of a call."
    }
];

// granted to @everyone by a channel override rather than by the role, which is
// where the misconfigurations nobody remembers making tend to sit
const CHANNEL_RULES: { perm: Permissions; level: Level; verb: string; detail: string; }[] = [
    { perm: "MANAGE_CHANNELS", level: Level.Critical, verb: "rename or delete the channel", detail: "" },
    { perm: "MANAGE_ROLES", level: Level.Critical, verb: "change who can see the channel", detail: "" },
    { perm: "MANAGE_WEBHOOKS", level: Level.Critical, verb: "create webhooks", detail: "A webhook keeps posting after the person is banned." },
    { perm: "MANAGE_MESSAGES", level: Level.Warning, verb: "delete anyone's messages", detail: "" },
    { perm: "MENTION_EVERYONE", level: Level.Warning, verb: "ping @everyone", detail: "" },
    { perm: "MANAGE_THREADS", level: Level.Warning, verb: "delete and lock threads", detail: "" },
    { perm: "MUTE_MEMBERS", level: Level.Warning, verb: "mute people in voice", detail: "" },
    { perm: "DEAFEN_MEMBERS", level: Level.Warning, verb: "deafen people in voice", detail: "" },
    { perm: "MOVE_MEMBERS", level: Level.Warning, verb: "drag people out of voice", detail: "" },
    { perm: "SEND_TTS_MESSAGES", level: Level.Warning, verb: "send text to speech messages", detail: "" }
];

// labels for the desync check below; the channel rules already name most of them
const CHANNEL_LABELS = new Map<Permissions, string>([
    ["VIEW_CHANNEL", "see the channel"],
    ["SEND_MESSAGES", "post in it"],
    ...CHANNEL_RULES.map(rule => [rule.perm, rule.verb] as [Permissions, string])
]);

const ELEVATED: Permissions[] = [
    "ADMINISTRATOR",
    "MANAGE_GUILD",
    "MANAGE_ROLES",
    "MANAGE_CHANNELS",
    "MANAGE_WEBHOOKS",
    "BAN_MEMBERS",
    "KICK_MEMBERS"
];

// a name Discord has renamed reads back as undefined, and mixing that into a
// bigint compare throws
export function has(permissions: bigint, perm: Permissions) {
    const bit = PermissionsBits[perm];
    return typeof bit === "bigint" && (permissions & bit) === bit;
}

/** every permission name held in a bitfield, so a role reads as words not a number */
export function permNames(bits: bigint): string[] {
    if (!bits) return [];

    return Object.entries(PermissionsBits)
        .filter(([, bit]) => typeof bit === "bigint" && (bits & bit) === bit)
        .map(([name]) => name);
}

/** MANAGE_WEBHOOKS reads as Manage Webhooks, which is what the Discord UI calls it */
export const prettyPerm = (perm: string) =>
    perm.toLowerCase().split("_").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");

export const list = (names: string[]) => names.length > 6
    ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more`
    : names.join(", ");

// English does not always just add an s, and "50 persons" reads like a police report
const IRREGULAR: Record<string, string> = {
    person: "people",
    is: "are",
    has: "have",
    was: "were",
    entry: "entries",
    category: "categories"
};

export const plural = (count: number, word: string) =>
    `${count} ${count === 1 ? word : IRREGULAR[word] ?? `${word}s`}`;

/** what @everyone ends up with in a channel once its own override is applied */
export function everyoneIn(channel: Channel, guildId: string, base: bigint) {
    const overwrite = channel.permissionOverwrites?.[guildId];
    if (!overwrite) return base;
    return (base & ~overwrite.deny) | overwrite.allow;
}

export function guildChannels(guildId: string): Channel[] {
    const buckets = GuildChannelStore.getChannels(guildId);
    return [...(buckets?.SELECTABLE ?? []), ...(buckets?.VOCAL ?? [])]
        .map((entry: { channel: Channel; }) => entry.channel);
}

export function auditGuild(guild: Guild): Report {
    const findings: Finding[] = [];
    const roles = GuildRoleStore.getSortedRoles(guild.id);
    const everyone = roles.find(role => role.id === guild.id);
    const named = roles.filter(role => role.id !== guild.id && !role.managed);

    const hasRole = (role: Role, perm: Permissions) => has(role.permissions, perm);

    if (everyone) {
        for (const rule of EVERYONE_RULES) {
            if (hasRole(everyone, rule.perm)) {
                findings.push({ level: rule.level, title: rule.title, detail: rule.detail, fix: { kind: "roles", roleId: guild.id } });
            }
        }
    }

    const admins = named.filter(role => hasRole(role, "ADMINISTRATOR"));
    if (admins.length) {
        findings.push({
            level: Level.Critical,
            title: `${plural(admins.length, "role")} grant Administrator`,
            detail: `${list(admins.map(r => r.name))}. Administrator ignores every channel override, so one compromised account in any of these owns the server. Give staff the specific permissions instead.`,
            fix: roleFix(admins)
        });
    }

    const mentionable = named.filter(role => role.mentionable && ELEVATED.some(perm => hasRole(role, perm)));
    if (mentionable.length) {
        findings.push({
            level: Level.Warning,
            title: `${plural(mentionable.length, "staff role")} can be pinged by anyone`,
            detail: `${list(mentionable.map(r => r.name))}. Anyone can summon staff on demand. Turn off "Allow anyone to @mention this role".`,
            fix: roleFix(mentionable)
        });
    }

    const webhooks = named.filter(role => !hasRole(role, "ADMINISTRATOR") && hasRole(role, "MANAGE_WEBHOOKS"));
    if (webhooks.length) {
        findings.push({
            level: Level.Warning,
            title: `${plural(webhooks.length, "role")} can manage webhooks`,
            detail: `${list(webhooks.map(r => r.name))}. A webhook posts under any name and keeps working after the person is banned, so this is worth keeping to the smallest group possible.`,
            fix: roleFix(webhooks)
        });
    }

    const bots = roles.filter(role => role.tags?.bot_id);

    const botAdmins = bots.filter(role => hasRole(role, "ADMINISTRATOR"));
    if (botAdmins.length) {
        findings.push({
            level: Level.Critical,
            title: `${plural(botAdmins.length, "bot")} run with Administrator`,
            detail: `${list(botAdmins.map(r => r.name))}. Setup guides ask for Administrator because it saves them listing what the bot actually needs, and a leaked bot token then owns the server. Give each bot only the permissions it uses.`,
            fix: roleFix(botAdmins)
        });
    }

    const staff = named.filter(role => ELEVATED.some(perm => hasRole(role, perm)));
    if (staff.length) {
        // a role can only be edited or removed by someone holding a higher one
        const ceiling = Math.max(...staff.map(role => role.position));
        const looseBots = bots.filter(role =>
            !hasRole(role, "ADMINISTRATOR")
            && role.position > ceiling
            && ELEVATED.some(perm => hasRole(role, perm)));

        if (looseBots.length) {
            findings.push({
                level: Level.Warning,
                title: `${plural(looseBots.length, "bot")} sit above your staff`,
                detail: `${list(looseBots.map(r => r.name))}. If one of these goes wrong your moderators cannot strip it, because it outranks them. Drag them below the staff roles.`,
                fix: roleFix(looseBots)
            });
        }
    }

    // Manage Roles hands out every role below your own, so a role holding it is
    // worth as much as the highest role underneath it
    const ladders = named
        .filter(role => !hasRole(role, "ADMINISTRATOR") && hasRole(role, "MANAGE_ROLES"))
        .map(role => ({
            role,
            reachable: named.filter(other =>
                other.position < role.position && ELEVATED.some(perm => hasRole(other, perm)))
        }))
        .filter(rung => rung.reachable.length);

    if (ladders.length) {
        findings.push({
            level: Level.Critical,
            title: `${plural(ladders.length, "role")} can promote themselves`,
            detail: `${ladders.map(rung => `${rung.role.name} can grant ${list(rung.reachable.map(r => r.name))}`).join("; ")}. That is a ladder to those permissions, not just a way to hand out colours.`,
            fix: roleFix(ladders.map(rung => rung.role))
        });
    }

    let reach: Reach | null = null;

    if (everyone && !hasRole(everyone, "ADMINISTRATOR")) {
        const channels = guildChannels(guild.id);
        const effective = channels.map(channel => ({
            id: channel.id,
            name: channel.name,
            nsfw: channel.nsfw,
            slowmode: channel.rateLimitPerUser,
            permissions: everyoneIn(channel, guild.id, everyone.permissions)
        }));

        if (effective.length) {
            const visible = effective.filter(c => has(c.permissions, "VIEW_CHANNEL"));

            reach = {
                total: effective.length,
                visible: visible.map(c => `#${c.name}`),
                postable: visible.filter(c => has(c.permissions, "SEND_MESSAGES")).map(c => `#${c.name}`)
            };

            for (const rule of CHANNEL_RULES) {
                // a permission the role already grants is reported above; this is
                // only about channels that hand it out on their own
                if (hasRole(everyone, rule.perm)) continue;

                const where = visible.filter(c => has(c.permissions, rule.perm));
                if (!where.length) continue;

                findings.push({
                    level: rule.level,
                    title: `Anyone can ${rule.verb} in ${plural(where.length, "channel")}`,
                    detail: `${list(where.map(c => `#${c.name}`))}. The role does not grant this, a channel override does. ${rule.detail}`.trim(),
                    fix: channelFix(where[0])
                });
            }

            // a channel is given a copy of its category's overrides when it is made,
            // it does not read through to them afterwards, so a gap means one of the
            // two was edited later and the other was left behind
            const desynced: { id: string; name: string; gained: string[]; }[] = [];
            for (const channel of channels) {
                const category = channel.parent_id ? ChannelStore.getChannel(channel.parent_id) : null;
                if (!category) continue;

                const here = everyoneIn(channel, guild.id, everyone.permissions);
                const above = everyoneIn(category, guild.id, everyone.permissions);
                const gained = [...CHANNEL_LABELS].filter(([perm]) => has(here, perm) && !has(above, perm));

                if (gained.length) desynced.push({ id: channel.id, name: channel.name, gained: gained.map(([, label]) => label) });
            }

            if (desynced.length) {
                findings.push({
                    level: Level.Warning,
                    title: desynced.length === 1
                        ? `#${desynced[0].name} is more open than its category`
                        : `${desynced.length} channels are more open than their category`,
                    detail: `${list(desynced.map(c => `#${c.name} lets anyone ${c.gained.join(" and ")}`))}. Fixing a category does not reach the channels under it, so this is usually a fix that was only half applied.`,
                    fix: channelFix(desynced[0])
                });
            }

            const postable = visible.filter(c => has(c.permissions, "SEND_MESSAGES"));

            // each half of this is ordinary on its own. together it is the button
            // a raid actually presses
            const amplifier = postable.filter(c => has(c.permissions, "MENTION_EVERYONE") && !c.slowmode);
            if (amplifier.length) {
                findings.push({
                    level: Level.Warning,
                    title: `${plural(amplifier.length, "channel")} let anyone ping everyone with no slowmode`,
                    detail: `${list(amplifier.map(c => `#${c.name}`))}. One account can ping the whole server as fast as it can type. Even five seconds of slowmode takes the speed out of it.`,
                    fix: channelFix(amplifier[0])
                });
            }

            // most channels having no slowmode is normal. none of them having any
            // means nobody has thought about it, which is the thing worth saying
            if (postable.length && postable.every(c => !c.slowmode)) {
                findings.push({
                    level: Level.Warning,
                    title: "No channel has slowmode",
                    detail: `Anyone can post as fast as they like in all ${plural(postable.length, "channel")} they can reach. Slowmode is the cheapest spam brake there is and it costs regular members nothing.`,
                    fix: channelFix(postable[0])
                });
            }

            const openNsfw = visible.filter(c => c.nsfw);
            if (openNsfw.length) {
                findings.push({
                    level: Level.Warning,
                    title: `Everyone can see ${plural(openNsfw.length, "age restricted channel")}`,
                    detail: `${list(openNsfw.map(c => `#${c.name}`))}. Age restricted asks for a birthday, it does not gate on a role. If these are not meant to be public, deny View Channel for @everyone.`,
                    fix: channelFix(openNsfw[0])
                });
            }
        }
    }

    if (guild.verificationLevel <= 1) {
        findings.push({
            level: Level.Warning,
            title: `Verification level is ${VERIFICATION_LEVELS[guild.verificationLevel]}`,
            detail: "An account made a minute ago can post straight away. Medium makes it wait five minutes, High requires a verified phone number.",
            fix: MODERATION
        });
    }

    if (guild.mfaLevel === 0 && named.some(role => ELEVATED.some(perm => hasRole(role, perm)))) {
        findings.push({
            level: Level.Warning,
            title: "Two-factor is not required for moderation",
            detail: "One phished staff account is enough to wreck the server. Require 2FA for moderator actions.",
            fix: MODERATION
        });
    }

    if (guild.explicitContentFilter !== 2) {
        findings.push({
            level: Level.Warning,
            title: "Media is not scanned for everyone",
            detail: guild.explicitContentFilter === 0
                ? "Nothing is scanned. Set it to scan messages from all members."
                : "Only members without a role are scanned. Set it to all members.",
            fix: MODERATION
        });
    }

    if (guild.features.has("RAID_ALERTS_DISABLED")) {
        findings.push({
            level: Level.Critical,
            title: "Raid alerts are turned off",
            detail: "Discord watches for join floods and suspicious sign up patterns for free, and this server has it switched off.",
            fix: safetyFix("SAFETY_CAPTCHA_AND_RAID_PROTECTION")
        });
    }

    if (everyone && hasRole(everyone, "CREATE_INSTANT_INVITE") && !guild.features.has("INVITES_DISABLED")) {
        findings.push({
            level: Level.Warning,
            title: "Anyone can create invites",
            detail: "Every member can mint a permanent link, and once one leaks you cannot revoke it without knowing which link it was. Keep Create Invite to the roles you trust.",
            fix: { kind: "roles", roleId: guild.id }
        });
    }

    if (guild.features.has("COMMUNITY") && !guild.features.has("MEMBER_VERIFICATION_GATE_ENABLED")) {
        findings.push({
            level: Level.Warning,
            title: "New members are not asked to agree to the rules",
            detail: "Membership screening makes a join click through your rules before they can talk, which stops most drive by trolls on its own.",
            fix: { kind: "settings", section: "MEMBER_VERIFICATION", label: "Open Membership Screening" }
        });
    }

    if (guild.features.has("COMMUNITY") && !guild.safetyAlertsChannelId) {
        findings.push({
            level: Level.Warning,
            title: "No safety alerts channel is set",
            detail: "This is where Discord posts raid warnings and its own moderation notices. Without one you find out from your members instead.",
            fix: safetyFix("SAFETY_OVERVIEW")
        });
    }

    if (
        everyone
        && hasRole(everyone, "CREATE_INSTANT_INVITE")
        && !guild.features.has("INVITES_DISABLED")
        && guild.verificationLevel <= 1
        && !guild.features.has("MEMBER_VERIFICATION_GATE_ENABLED")
    ) {
        findings.push({
            level: Level.Critical,
            title: "The front door is wide open",
            detail: "Anyone can make an invite, nothing checks who walks in, and they can talk the second they arrive. Each of those is reported on its own above, but together there is no step at all between a raider deciding to come and being in your channels. Fixing any one of the three breaks the chain.",
            fix: MODERATION
        });
    }

    if (guild.mfaLevel === 0 && webhooks.length) {
        findings.push({
            level: Level.Warning,
            title: "Webhook power with no two-factor behind it",
            detail: `${list(webhooks.map(r => r.name))} can create webhooks, and moderation does not require 2FA. A phished password is enough to plant a webhook that keeps posting after the account is banned.`,
            fix: MODERATION
        });
    }

    return { findings: findings.sort((a, b) => a.level - b.level), reach };
}

interface OnboardingConfig {
    enabled?: boolean;
    prompts?: { options?: { role_ids?: string[]; }[]; }[];
    default_channel_ids?: string[];
}

/** onboarding is the one part of the setup that is not in any store until something
 *  asks for it, so this is the only check that costs a request */
export async function auditOnboarding(guild: Guild): Promise<Finding[]> {
    if (!guild.features.has("GUILD_ONBOARDING")) return [];

    let config: OnboardingConfig;
    try {
        config = (await RestAPI.get({ url: `/guilds/${guild.id}/onboarding` })).body;
    } catch {
        return [];
    }

    if (!config?.enabled) return [];

    const findings: Finding[] = [];
    const byId = new Map(GuildRoleStore.getSortedRoles(guild.id).map(role => [role.id, role]));

    const offered = (config.prompts ?? [])
        .flatMap(prompt => prompt.options ?? [])
        .flatMap(option => option.role_ids ?? [])
        .map(id => byId.get(id))
        .filter((role): role is Role => role != null && ELEVATED.some(perm => has(role.permissions, perm)));

    if (offered.length) {
        const names = [...new Set(offered.map(role => role.name))];
        findings.push({
            level: Level.Critical,
            title: "Onboarding hands out a role with real power",
            detail: `${list(names)}. Anyone can take these by clicking a button in the welcome flow, with nobody approving it. Onboarding is for interests and pronouns, not permissions.`,
            fix: { kind: "settings", section: "ONBOARDING", label: "Open Onboarding" }
        });
    }

    const landing = (config.default_channel_ids ?? [])
        .map(id => ChannelStore.getChannel(id))
        .filter((channel): channel is Channel => channel != null);

    const restricted = landing.filter(channel => channel.nsfw);
    if (restricted.length) {
        findings.push({
            level: Level.Warning,
            title: `New members land straight in ${plural(restricted.length, "age restricted channel")}`,
            detail: `${list(restricted.map(c => `#${c.name}`))}. Onboarding drops every new join into its default channels, so this is the first thing they see.`,
            fix: channelFix(restricted[0])
        });
    }

    return findings;
}

interface AutomodRule {
    enabled?: boolean;
    trigger_type?: number;
}

/** Discord's own spam filters are free and off by default, so their absence is
 *  worth as much as any permission mistake */
export async function auditAutomod(guild: Guild): Promise<Finding[]> {
    let rules: AutomodRule[];
    try {
        rules = (await RestAPI.get({ url: `/guilds/${guild.id}/auto-moderation/rules` })).body ?? [];
    } catch {
        return [];
    }

    const live = rules.filter(rule => rule.enabled !== false);
    // 3 is the mention spam trigger, 4 is Discord's own spam classifier
    const kinds = new Set(live.map(rule => rule.trigger_type));

    const findings: Finding[] = [];
    const fix: Fix = { kind: "settings", section: "GUILD_AUTOMOD", label: "Open AutoMod" };

    if (!live.length) {
        findings.push({
            level: Level.Critical,
            title: "AutoMod is not doing anything",
            detail: "No rule is switched on. Discord will block spam and mention floods for free, before a moderator has to be awake, and this server is not using any of it.",
            fix
        });
        return findings;
    }

    if (!kinds.has(4)) {
        findings.push({
            level: Level.Warning,
            title: "Discord's spam filter is off",
            detail: `${plural(live.length, "AutoMod rule")} running, but none of them is the built in spam classifier. It is the one that costs you nothing to switch on.`,
            fix
        });
    }

    if (!kinds.has(3)) {
        findings.push({
            level: Level.Warning,
            title: "Nothing limits mass mentions",
            detail: "No rule caps how many people one message can ping. That is the cheapest way for one account to make a lot of noise.",
            fix
        });
    }

    return findings;
}

/** used by the live watch, which only ever reports the critical findings */
export function criticalTitles(guild: Guild): string[] {
    return auditGuild(guild).findings
        .filter(finding => finding.level === Level.Critical)
        .map(finding => finding.title);
}

function reachSentence(reach: Reach) {
    return `A brand new account sees ${reach.visible.length} of ${plural(reach.total, "channel")} and can post in ${reach.postable.length}.`;
}

const readOnly = (reach: Reach) => reach.visible.filter(name => !reach.postable.includes(name));

function asText(guild: Guild, { findings, reach }: Report, accepted: string[]) {
    const line = (f: Finding) => `[${f.level === Level.Critical ? "critical" : "warning"}] ${f.title}\n    ${f.detail}`;
    const open = findings.filter(f => !accepted.includes(f.title));
    const done = findings.filter(f => accepted.includes(f.title));

    const head = reach
        ? `${reachSentence(reach)}\n\nCan post in: ${reach.postable.join(", ") || "nothing"}\nCan only read: ${readOnly(reach).join(", ") || "nothing"}\n\n`
        : "";
    const tail = done.length ? `\n\nAccepted\n\n${done.map(line).join("\n\n")}` : "";

    return `${guild.name} permission check\n\n${head}${open.map(line).join("\n\n")}${tail}`;
}

interface Baseline {
    at: number;
    titles: string[];
}

export interface SafetyState {
    baseline: Baseline | null;
    accepted: string[];
}

export const stateKey = (guildId: string) => `serverInfo-safety-${guildId}`;

/** what one server contributes to the cross server list. onboarding is left out on
 *  purpose: this runs for every server at once and that check costs a request each */
export function scoreGuild(guild: Guild, accepted: string[]) {
    const open = auditGuild(guild).findings.filter(finding => !accepted.includes(finding.title));
    return {
        critical: open.filter(finding => finding.level === Level.Critical).length,
        total: open.length
    };
}

async function loadState(guildId: string): Promise<SafetyState> {
    const stored = await DataStore.get<Partial<SafetyState & Baseline>>(stateKey(guildId));
    if (!stored) return { baseline: null, accepted: [] };

    // the first version of this wrote a bare snapshot under the same key
    if (Array.isArray(stored.titles)) return { baseline: { at: stored.at ?? 0, titles: stored.titles }, accepted: [] };

    return { baseline: stored.baseline ?? null, accepted: stored.accepted ?? [] };
}

function FixButton({ fix, guildId, onClose }: { fix: Fix; guildId: string; onClose(): void; }) {
    return (
        <Button
            size={Button.Sizes.SMALL}
            look={Button.Looks.LINK}
            onClick={async () => {
                onClose();
                if (fix.kind === "channel") return ChannelRouter.transitionToChannel(fix.id);
                if (fix.kind === "settings") return GuildSettingsActions.open(guildId, fix.section, undefined, fix.subsection);

                await GuildSettingsActions.open(guildId, "ROLES");
                if (fix.roleId) GuildSettingsActions.selectRole(fix.roleId);
            }}
        >
            {fix.kind === "channel"
                ? `Go to #${fix.name}`
                : fix.kind === "settings"
                    ? fix.label
                    : fix.roleId ? "Open the role" : "Open role settings"}
        </Button>
    );
}

export const SafetyTab = ErrorBoundary.wrap(({ guild, onClose }: { guild: Guild; onClose(): void; }) => {
    const base = auditGuild(guild);

    const [showChannels, setShowChannels] = useState(false);
    const [showTrail, setShowTrail] = useState(false);
    const [showAccepted, setShowAccepted] = useState(false);
    const [state, setState] = useState<SafetyState>();
    const [onboarding, setOnboarding] = useState<Finding[]>([]);

    const findings = [...base.findings, ...onboarding].sort((a, b) => a.level - b.level);
    const report: Report = { ...base, findings };
    const { reach } = report;

    useEffect(() => {
        let live = true;
        setOnboarding([]);
        Promise.all([auditOnboarding(guild), auditAutomod(guild)])
            .then(([a, b]) => { if (live) setOnboarding([...a, ...b]); });
        return () => { live = false; };
    }, [guild.id]);

    useEffect(() => {
        let live = true;
        loadState(guild.id).then(stored => { if (live) setState(stored); });
        return () => { live = false; };
    }, [guild.id]);

    if (!state) return null;

    const save = (next: SafetyState) => {
        setState(next);
        void DataStore.set(stateKey(guild.id), next);
    };

    const { baseline } = state;
    const open = findings.filter(f => !state.accepted.includes(f.title));
    const accepted = findings.filter(f => state.accepted.includes(f.title));
    const critical = open.filter(f => f.level === Level.Critical).length;

    const seen = baseline ? new Set(baseline.titles) : null;
    const fixed = baseline ? baseline.titles.filter(title => !findings.some(f => f.title === title)) : [];
    const appeared = seen ? findings.filter(f => !seen.has(f.title)).length : 0;
    const since = baseline && new Date(baseline.at).toLocaleString();

    return (
        <div className={cl("safety")}>
            {reach && (
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">{reachSentence(reach)}</Text>
                    <Text variant="text-sm/normal">Counted from the channels you can see, with only @everyone applied.</Text>

                    <Button
                        className={cl("safety-toggle")}
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.LINK}
                        onClick={() => setShowChannels(v => !v)}
                    >
                        {showChannels ? "Hide the channels" : "Which channels?"}
                    </Button>

                    {showChannels && (
                        <div className={cl("safety-channels")}>
                            <div>
                                <span className={cl("safety-channels-label")}>Can post in</span>
                                {reach.postable.join(", ") || "nothing"}
                            </div>
                            <div>
                                <span className={cl("safety-channels-label")}>Can only read</span>
                                {readOnly(reach).join(", ") || "nothing"}
                            </div>
                        </div>
                    )}
                </div>
            )}

            <div className={cl("safety-since")}>
                <Text variant="text-sm/normal">
                    {!baseline
                        ? "No baseline recorded. Once this server is the way you want it, save one and the tab will only tell you what moved after that."
                        : appeared || fixed.length
                            ? `Since the baseline you saved on ${since}: ${plural(appeared, "new problem")}, ${fixed.length} fixed.`
                            : `Nothing has changed since the baseline you saved on ${since}.`}
                </Text>
                {fixed.length > 0 && <Text variant="text-sm/normal">Fixed: {list(fixed)}</Text>}

                <div className={cl("safety-actions-right")}>
                    <Button
                        className={cl("safety-toggle")}
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.LINK}
                        onClick={() => save({ ...state, baseline: { at: Date.now(), titles: findings.map(f => f.title) } })}
                    >
                        {baseline ? "Move the baseline to now" : "Save this as the baseline"}
                    </Button>
                    <Button
                        className={cl("safety-toggle")}
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.LINK}
                        onClick={() => setShowTrail(v => !v)}
                    >
                        {showTrail ? "Hide who changed things" : "Who changed things"}
                    </Button>
                </div>

                {showTrail && <AuditTrail guild={guild} />}
            </div>

            {!open.length ? (
                <div className={cl("safety-clear")}>
                    <Text variant="text-md/semibold">{accepted.length ? "Nothing left to fix" : "Nothing to flag"}</Text>
                    <Text variant="text-sm/normal">
                        {accepted.length
                            ? "Everything the check found has been accepted."
                            : "@everyone holds no dangerous permissions, no channel override hands one out, no role or bot grants Administrator, nobody can promote themselves, and the server's gates and safety settings are set sensibly."}
                    </Text>
                </div>
            ) : (
                <>
                    <div className={cl("safety-actions")}>
                        <Text variant="text-sm/normal">
                            {critical
                                ? `${critical} of ${open.length} need fixing now.`
                                : `${plural(open.length, "thing")} worth tightening.`}
                        </Text>
                        <div className={cl("safety-actions-right")}>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                className={cl("safety-panic")}
                                onClick={() => openEmergencyModal(guild)}
                            >
                                Emergency
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => openRecentJoinsModal(guild)}
                            >
                                Recent joins
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => openBroadcastModal(guild)}
                            >
                                Broadcast
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => openInspectModal(guild)}
                            >
                                Look around
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => openBulkModal(guild)}
                            >
                                Bulk changes
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                className={cl("safety-panic")}
                                onClick={() => openPurgeModal(guild)}
                            >
                                Clear messages
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => openRoleDiffModal(guild)}
                            >
                                Compare roles
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={openHistoryModal}
                            >
                                History
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={openAllServersModal}
                            >
                                Check every server
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => copyToClipboard(asText(guild, report, state.accepted))}
                            >
                                Copy report
                            </Button>
                        </div>
                    </div>

                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {open.map(finding => (
                            <div
                                key={finding.title}
                                className={cl("safety-row", { critical: finding.level === Level.Critical })}
                            >
                                <div className={cl("safety-title")}>
                                    {finding.title}
                                    {seen && !seen.has(finding.title) && <span className={cl("safety-new")}>new</span>}
                                </div>
                                <div className={cl("safety-detail")}>{finding.detail}</div>
                                <div className={cl("safety-row-actions")}>
                                    {finding.fix && <FixButton fix={finding.fix} guildId={guild.id} onClose={onClose} />}
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        look={Button.Looks.LINK}
                                        onClick={() => openBroadcastModal(guild, `${finding.title}. ${finding.detail}`)}
                                    >
                                        Tell the team
                                    </Button>
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        look={Button.Looks.LINK}
                                        onClick={() => save({ ...state, accepted: [...state.accepted, finding.title] })}
                                    >
                                        Accept this
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </ScrollerThin>
                </>
            )}

            {accepted.length > 0 && (
                <div className={cl("safety-accepted")}>
                    <Button
                        className={cl("safety-toggle")}
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.LINK}
                        onClick={() => setShowAccepted(v => !v)}
                    >
                        {showAccepted ? "Hide accepted" : `Accepted (${accepted.length})`}
                    </Button>

                    {showAccepted && accepted.map(finding => (
                        <div key={finding.title} className={cl("safety-row", "safety-row-accepted")}>
                            <div className={cl("safety-title")}>{finding.title}</div>
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                onClick={() => save({ ...state, accepted: state.accepted.filter(t => t !== finding.title) })}
                            >
                                Put it back
                            </Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
});
