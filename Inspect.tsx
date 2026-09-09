/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps, Role } from "@vencord/discord-types";
import { Button, ChannelStore, Forms, GuildMemberStore, GuildRoleStore, Modal, openModal, RestAPI, ScrollerThin, Select, SnowflakeUtils, Text, useEffect, useState } from "@webpack/common";

import { fetchTrail, TrailEntry } from "./AuditTrail";
import { PersonCard } from "./PersonCard";
import { everyoneIn, guildChannels, has, list, plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

type Section = "readiness" | "staff" | "webhooks" | "bans" | "queue" | "visibility";

const TABS: { id: Section; label: string; }[] = [
    { id: "readiness", label: "Readiness" },
    { id: "staff", label: "Who moderates" },
    { id: "webhooks", label: "Webhooks" },
    { id: "bans", label: "Bans" },
    { id: "queue", label: "Waiting to join" },
    { id: "visibility", label: "Who sees a channel" }
];

interface Webhook {
    id: string;
    name: string;
    type?: number;
    token?: string | null;
    channel_id: string;
    application_id?: string | null;
    user?: { id: string; username: string; global_name?: string | null; } | null;
    source_guild?: { name: string; } | null;
    source_channel?: { name: string; } | null;
}

/** 1 is a plain incoming hook, 2 is a channel follow, 3 belongs to an app */
const HOOK_KIND: Record<number, string> = {
    1: "An incoming webhook, which anyone holding its URL can post through",
    2: "A channel follow, which republishes another server's announcements here",
    3: "Owned by an application, which posts through it as itself"
};

interface Ban {
    reason?: string | null;
    user: { id: string; username: string; global_name?: string | null; };
}

interface JoinRequest {
    user: { id: string; username: string; global_name?: string | null; };
    created_at?: string;
    rejection_reason?: string | null;
}

function useFetch<T>(url: string, query?: Record<string, string>) {
    const [data, setData] = useState<T | "denied">();

    useEffect(() => {
        let live = true;
        RestAPI.get({ url, query })
            .then(({ body }) => { if (live) setData(body); })
            .catch(() => { if (live) setData("denied"); });
        return () => { live = false; };
    }, [url]);

    return data;
}

function Loading({ what }: { what: string; }) {
    return <Text variant="text-sm/normal">Reading {what}...</Text>;
}

function Denied({ need }: { need: string; }) {
    return <Text variant="text-sm/normal">You need {need} in this server to see this.</Text>;
}

function Webhooks({ guild }: { guild: Guild; }) {
    const hooks = useFetch<Webhook[]>(`/guilds/${guild.id}/webhooks`);
    const [open, setOpen] = useState<string>();

    if (!hooks) return <Loading what="the webhooks" />;
    if (hooks === "denied") return <Denied need="Manage Webhooks" />;
    if (!hooks.length) return <Text variant="text-sm/normal">This server has no webhooks at all.</Text>;

    return (
        <>
            <Text variant="text-sm/normal">
                {plural(hooks.length, "webhook")}. Each one posts under any name and avatar it likes, and keeps working after whoever made it is banned.
            </Text>
            <ScrollerThin className={cl("scroller")} orientation="vertical">
                {hooks.map(hook => (
                    <div key={hook.id} className={cl("safety-row")}>
                        <button
                            type="button"
                            className={cl("linkish", "safety-title", "row-open")}
                            aria-expanded={open === hook.id}
                            onClick={() => setOpen(open === hook.id ? undefined : hook.id)}
                        >
                            {hook.name}
                        </button>
                        <div className={cl("safety-detail")}>
                            Posts into #{ChannelStore.getChannel(hook.channel_id)?.name ?? "a channel you cannot see"}
                            {hook.application_id
                                ? ", owned by an app"
                                : hook.user ? `, made by ${hook.user.global_name || hook.user.username}` : ""}
                        </div>

                        {open === hook.id && (
                            <div className={cl("joins-detail")}>
                                <div>{HOOK_KIND[hook.type ?? 1] ?? "Discord did not say what kind this is"}</div>
                                <div>Made on {new Date(SnowflakeUtils.extractTimestamp(hook.id)).toLocaleString()}</div>
                                <div>
                                    Made by {hook.user ? `${hook.user.global_name || hook.user.username}, id ${hook.user.id}` : "somebody Discord will not name"}
                                    {hook.user && !GuildMemberStore.getMember(guild.id, hook.user.id) && ", who is no longer in this server"}
                                </div>
                                {hook.source_guild && (
                                    <div>Follows #{hook.source_channel?.name ?? "a channel"} in {hook.source_guild.name}</div>
                                )}
                                <div>Webhook id {hook.id}</div>
                                {hook.token != null && (
                                    <div className={cl("joins-flags")}>
                                        This one has a token, so the full URL is enough to post through it. Anyone who has ever
                                        copied that URL can still post here under any name and picture they like, and banning
                                        them does not stop it. Deleting the webhook is the only thing that does.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </ScrollerThin>
        </>
    );
}

function Bans({ guild }: { guild: Guild; }) {
    const bans = useFetch<Ban[]>(`/guilds/${guild.id}/bans`, { limit: "100" });
    const [open, setOpen] = useState<string>();

    if (!bans) return <Loading what="the ban list" />;
    if (bans === "denied") return <Denied need="Ban Members" />;
    if (!bans.length) return <Text variant="text-sm/normal">Nobody is banned.</Text>;

    const unexplained = bans.filter(entry => !entry.reason).length;

    return (
        <>
            <Text variant="text-sm/normal">
                {plural(bans.length, "ban")}, showing the most recent hundred. {unexplained
                    ? `${unexplained} have no reason written down, so nobody can tell why later.`
                    : "Every one has a reason on it."}
            </Text>
            <ScrollerThin className={cl("scroller")} orientation="vertical">
                {bans.map(entry => (
                    <div key={entry.user.id} className={cl("safety-row")}>
                        <button
                            type="button"
                            className={cl("linkish", "safety-title", "row-open")}
                            aria-expanded={open === entry.user.id}
                            onClick={() => setOpen(open === entry.user.id ? undefined : entry.user.id)}
                        >
                            {entry.user.global_name || entry.user.username}
                        </button>
                        <div className={cl("safety-detail")}>{entry.reason || "No reason was given"}</div>
                        {open === entry.user.id && (
                            <PersonCard
                                guild={guild}
                                userId={entry.user.id}
                                fallbackName={entry.user.global_name || entry.user.username}
                                extra={entry.reason ?? "Banned with no reason written down"}
                            />
                        )}
                    </div>
                ))}
            </ScrollerThin>
        </>
    );
}

function Queue({ guild }: { guild: Guild; }) {
    const requests = useFetch<{ guild_join_requests?: JoinRequest[]; }>(`/guilds/${guild.id}/requests`, { status: "PENDING", limit: "50" });
    const [open, setOpen] = useState<string>();

    if (!requests) return <Loading what="the join queue" />;
    if (requests === "denied") return <Denied need="Manage Server or Kick Members" />;

    const waiting = requests.guild_join_requests ?? [];
    if (!waiting.length) return <Text variant="text-sm/normal">Nobody is waiting to be let in.</Text>;

    return (
        <>
            <Text variant="text-sm/normal">{plural(waiting.length, "person")} waiting for someone to approve them.</Text>
            <ScrollerThin className={cl("scroller")} orientation="vertical">
                {waiting.map(request => (
                    <div key={request.user.id} className={cl("safety-row")}>
                        <button
                            type="button"
                            className={cl("linkish", "safety-title", "row-open")}
                            aria-expanded={open === request.user.id}
                            onClick={() => setOpen(open === request.user.id ? undefined : request.user.id)}
                        >
                            {request.user.global_name || request.user.username}
                        </button>
                        {request.created_at && (
                            <div className={cl("safety-detail")}>Asked on {new Date(request.created_at).toLocaleString()}</div>
                        )}
                        {open === request.user.id && (
                            <PersonCard
                                guild={guild}
                                userId={request.user.id}
                                fallbackName={request.user.global_name || request.user.username}
                            />
                        )}
                    </div>
                ))}
            </ScrollerThin>
        </>
    );
}

function Visibility({ guild }: { guild: Guild; }) {
    const channels = guildChannels(guild.id);
    const [channelId, setChannelId] = useState(channels[0]?.id ?? "");

    const channel = channels.find(c => c.id === channelId);
    const roles = GuildRoleStore.getSortedRoles(guild.id);
    const everyone = roles.find(role => role.id === guild.id);

    const forRole = (role: Role) => {
        if (!channel || !everyone) return 0n;
        if (has(role.permissions, "ADMINISTRATOR")) return ~0n;

        const base = everyoneIn(channel, guild.id, everyone.permissions | role.permissions);
        const own = channel.permissionOverwrites?.[role.id];
        return own ? (base & ~own.deny) | own.allow : base;
    };

    const seeing = roles.filter(role => has(forRole(role), "VIEW_CHANNEL"));
    const posting = seeing.filter(role => has(forRole(role), "SEND_MESSAGES"));
    const readOnly = seeing.filter(role => !posting.includes(role));
    const naming = (role: Role) => role.id === guild.id ? "@everyone" : role.name;

    return (
        <>
            <div className={cl("cast-row")}>
                <Text variant="text-sm/normal">Channel</Text>
                <Select
                    options={channels.map(c => ({ label: `#${c.name}`, value: c.id }))}
                    select={setChannelId}
                    isSelected={value => value === channelId}
                    serialize={String}
                />
            </div>

            <div className={cl("safety-row")}>
                <div className={cl("safety-title")}>Can post in it</div>
                <div className={cl("safety-detail")}>{list(posting.map(naming)) || "nobody"}</div>
            </div>
            <div className={cl("safety-row")}>
                <div className={cl("safety-title")}>Can read it but not post</div>
                <div className={cl("safety-detail")}>{list(readOnly.map(naming)) || "nobody"}</div>
            </div>
            <div className={cl("safety-row")}>
                <div className={cl("safety-title")}>Cannot see it</div>
                <div className={cl("safety-detail")}>{list(roles.filter(role => !seeing.includes(role)).map(naming)) || "nobody"}</div>
            </div>
        </>
    );
}

function Readiness({ guild }: { guild: Guild; }) {
    const rules = useFetch<{ enabled?: boolean; trigger_type?: number; }[]>(`/guilds/${guild.id}/auto-moderation/rules`);
    const everyone = GuildRoleStore.getSortedRoles(guild.id).find(role => role.id === guild.id);
    const incidents = (guild as any).incidentsData;
    const live = Array.isArray(rules) ? rules.filter(rule => rule.enabled !== false) : [];
    const kinds = new Set(live.map(rule => rule.trigger_type));

    const checks: { ok: boolean; label: string; }[] = [
        { ok: guild.verificationLevel >= 2, label: "New accounts have to wait before they can talk" },
        { ok: guild.explicitContentFilter === 2, label: "Media from every member is scanned" },
        { ok: guild.mfaLevel !== 0, label: "Moderators need two factor to act" },
        { ok: !guild.features.has("RAID_ALERTS_DISABLED"), label: "Raid alerts are on" },
        { ok: !guild.features.has("COMMUNITY") || guild.features.has("MEMBER_VERIFICATION_GATE_ENABLED"), label: "New members agree to the rules first" },
        { ok: !!guild.safetyAlertsChannelId || !guild.features.has("COMMUNITY"), label: "Discord has somewhere to post safety warnings" },
        { ok: !everyone || !has(everyone.permissions, "CREATE_INSTANT_INVITE"), label: "Invites are not open to everyone" },
        { ok: rules === undefined ? false : kinds.has(4), label: "Discord's spam filter is running" },
        { ok: rules === undefined ? false : kinds.has(3), label: "Mass mentions are capped" },
        { ok: incidents?.invitesDisabledUntil != null && new Date(incidents.invitesDisabledUntil) > new Date(), label: "Invites are paused right now" }
    ];

    const on = checks.filter(check => check.ok).length;

    return (
        <>
            <Text variant="text-md/semibold">{on} of {checks.length} in place.</Text>
            <Text variant="text-sm/normal">The last one is only meant to be on during an incident, so a cross there is normal.</Text>
            <ScrollerThin className={cl("scroller")} orientation="vertical">
                {checks.map(check => (
                    <div key={check.label} className={cl("ready-row")}>
                        <span className={cl(check.ok ? "ready-yes" : "ready-no")}>{check.ok ? "✓" : "✗"}</span>
                        {check.label}
                    </div>
                ))}
            </ScrollerThin>
        </>
    );
}

function Staff({ guild }: { guild: Guild; }) {
    const [trail, setTrail] = useState<TrailEntry[] | "denied">();
    const [open, setOpen] = useState<string>();

    useEffect(() => {
        let live = true;
        fetchTrail(guild).then(result => { if (live) setTrail(result); });
        return () => { live = false; };
    }, [guild.id]);

    if (!trail) return <Loading what="the audit log" />;
    if (trail === "denied") return <Denied need="View Audit Log" />;
    if (!trail.length) return <Text variant="text-sm/normal">Nothing in the recent audit log to count.</Text>;

    const counts = new Map<string, { name: string; count: number; last: number; }>();
    for (const entry of trail) {
        const key = entry.whoId ?? entry.who;
        const seen = counts.get(key);
        counts.set(key, { name: entry.who, count: (seen?.count ?? 0) + 1, last: seen?.last ?? entry.at });
    }
    const ranked = [...counts].sort((a, b) => b[1].count - a[1].count);

    return (
        <>
            <Text variant="text-sm/normal">
                Who actually changed something in the last hundred audit log entries, most active first. Somebody with power who never appears here is worth a thought.
            </Text>
            <ScrollerThin className={cl("scroller")} orientation="vertical">
                {ranked.map(([key, who]) => (
                    <div key={key} className={cl("safety-row")}>
                        <button
                            type="button"
                            className={cl("linkish", "safety-title", "row-open")}
                            aria-expanded={open === key}
                            onClick={() => setOpen(open === key ? undefined : key)}
                        >
                            {who.name}
                        </button>
                        <div className={cl("safety-detail")}>{plural(who.count, "change")}, most recently {new Date(who.last).toLocaleString()}</div>
                        {open === key && (
                            /^\d+$/.test(key)
                                ? (
                                    <PersonCard guild={guild} userId={key} fallbackName={who.name}>
                                        <div className={cl("card-did")}>
                                            <span className={cl("safety-channels-label")}>What they changed</span>
                                            {trail.filter(entry => (entry.whoId ?? entry.who) === key).slice(0, 15).map(entry => (
                                                <div key={entry.id}>
                                                    {new Date(entry.at).toLocaleString()}: {entry.text}
                                                    {entry.reason && `, because: ${entry.reason}`}
                                                </div>
                                            ))}
                                        </div>
                                    </PersonCard>
                                )
                                : (
                                    <div className={cl("joins-detail")}>
                                        {trail.filter(entry => (entry.whoId ?? entry.who) === key).slice(0, 15).map(entry => (
                                            <div key={entry.id}>
                                                {new Date(entry.at).toLocaleString()}: {entry.text}
                                                {entry.reason && `, because: ${entry.reason}`}
                                            </div>
                                        ))}
                                    </div>
                                )
                        )}
                    </div>
                ))}
            </ScrollerThin>
        </>
    );
}

function Inspect({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const [tab, setTab] = useState<Section>("readiness");

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Look around {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-actions-right")}>
                    {TABS.map(entry => (
                        <Button
                            key={entry.id}
                            size={Button.Sizes.SMALL}
                            look={tab === entry.id ? Button.Looks.FILLED : Button.Looks.LINK}
                            onClick={() => setTab(entry.id)}
                        >
                            {entry.label}
                        </Button>
                    ))}
                </div>

                <div className={cl("inspect-body")}>
                    {tab === "readiness" && <Readiness guild={guild} />}
                    {tab === "staff" && <Staff guild={guild} />}
                    {tab === "webhooks" && <Webhooks guild={guild} />}
                    {tab === "bans" && <Bans guild={guild} />}
                    {tab === "queue" && <Queue guild={guild} />}
                    {tab === "visibility" && <Visibility guild={guild} />}
                </div>
            </div>
        </Modal>
    );
}

export function openInspectModal(guild: Guild) {
    openModal(props => <Inspect guild={guild} modalProps={props} />);
}
