/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Channel, Guild, Permissions, RenderModalProps, Role } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildMemberStore, GuildRoleStore, Modal, openModal, PermissionsBits, RestAPI, ScrollerThin, Text, Toasts, UserStore, useState } from "@webpack/common";

import { record, Target } from "./History";
import { canModerate, openPunishModal } from "./Punish";
import { guildChannels, has, list, plural, prettyPerm } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const POWERS: { perm: Permissions; label: string; }[] = [
    { perm: "ADMINISTRATOR", label: "do everything, ignoring every channel override" },
    { perm: "MANAGE_GUILD", label: "change the server's settings" },
    { perm: "MANAGE_ROLES", label: "hand out every role below their own" },
    { perm: "MANAGE_CHANNELS", label: "rename, reorder and delete channels" },
    { perm: "MANAGE_WEBHOOKS", label: "create webhooks" },
    { perm: "BAN_MEMBERS", label: "ban people" },
    { perm: "KICK_MEMBERS", label: "kick people" },
    { perm: "MODERATE_MEMBERS", label: "time people out" },
    { perm: "MANAGE_GUILD_EXPRESSIONS", label: "delete and replace emoji" },
    { perm: "MANAGE_MESSAGES", label: "delete anyone's messages" },
    { perm: "MENTION_EVERYONE", label: "ping everyone" },
    { perm: "MOVE_MEMBERS", label: "drag people between voice channels" }
];

/** Discord's own order: the @everyone override, then every role override pooled
 *  together and applied once, then the one aimed at this person */
function memberIn(channel: Channel, guildId: string, roleIds: string[], userId: string, base: bigint) {
    const overwrites = channel.permissionOverwrites ?? {};
    let permissions = base;

    const everyone = overwrites[guildId];
    if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;

    let deny = 0n;
    let allow = 0n;
    for (const id of roleIds) {
        const overwrite = overwrites[id];
        if (overwrite) {
            deny |= overwrite.deny;
            allow |= overwrite.allow;
        }
    }
    permissions = (permissions & ~deny) | allow;

    const mine = overwrites[userId];
    if (mine) permissions = (permissions & ~mine.deny) | mine.allow;

    return permissions;
}

const topPosition = (roles: Map<string, Role>, ids: string[] | undefined) =>
    Math.max(-1, ...(ids ?? []).map(id => roles.get(id)?.position ?? -1));

function MemberPower({ guild, userId, modalProps }: { guild: Guild; userId: string; modalProps: RenderModalProps; }) {
    const roles = new Map(GuildRoleStore.getSortedRoles(guild.id).map(role => [role.id, role]));
    const member = GuildMemberStore.getMember(guild.id, userId);
    const user = UserStore.getUser(userId);
    const name = member?.nick || user?.username || "They";

    const held = (member?.roles ?? []).map(id => roles.get(id)).filter((role): role is Role => role != null);
    const everyoneRole = roles.get(guild.id);

    const [showChannels, setShowChannels] = useState(false);
    const [edits, setEdits] = useState<Record<string, bigint>>({});
    const [dropped, setDropped] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    const permsOf = (role: Role) => edits[role.id] ?? role.permissions;

    let base = everyoneRole ? permsOf(everyoneRole) : 0n;
    for (const role of held) if (!dropped.includes(role.id)) base |= permsOf(role);

    const owner = guild.ownerId === userId;
    const admin = owner || has(base, "ADMINISTRATOR");

    const me = UserStore.getCurrentUser().id;
    const myTop = topPosition(roles, GuildMemberStore.getMember(guild.id, me)?.roles);
    const theirTop = topPosition(roles, member?.roles);
    const iOwn = guild.ownerId === me;

    let myBase = everyoneRole?.permissions ?? 0n;
    for (const id of GuildMemberStore.getMember(guild.id, me)?.roles ?? []) {
        const role = roles.get(id);
        if (role) myBase |= role.permissions;
    }
    const canManage = iOwn || has(myBase, "ADMINISTRATOR") || has(myBase, "MANAGE_ROLES");
    const canEdit = (role: Role) => canManage && (iOwn || role.position < myTop);

    const roleIds = [guild.id, ...(member?.roles ?? []).filter(id => !dropped.includes(id))];
    const channels = guildChannels(guild.id).map(channel => ({
        name: channel.name,
        permissions: memberIn(channel, guild.id, roleIds, userId, base)
    }));

    const visible = admin ? channels : channels.filter(c => has(c.permissions, "VIEW_CHANNEL"));
    const postable = admin ? channels : visible.filter(c => has(c.permissions, "SEND_MESSAGES"));
    const moderating = admin ? channels : visible.filter(c => has(c.permissions, "MANAGE_MESSAGES"));
    const readOnly = visible.filter(c => !postable.includes(c));
    const hidden = channels.filter(c => !visible.includes(c));

    const powers = POWERS.filter(power => has(base, power.perm));

    // @everyone is not in member.roles but is very often where the power comes from
    const sources = [everyoneRole, ...held]
        .filter((role): role is Role => role != null)
        .filter(role => POWERS.some(power => has(role.permissions, power.perm) || has(permsOf(role), power.perm)));

    const changed = sources.filter(role => edits[role.id] != null && edits[role.id] !== role.permissions);
    const dirty = changed.length > 0 || dropped.length > 0;

    function toggle(role: Role, perm: Permissions, on: boolean) {
        const bit = PermissionsBits[perm];
        if (typeof bit !== "bigint") return;

        const next = on ? permsOf(role) | bit : permsOf(role) & ~bit;
        setEdits(prev => ({ ...prev, [role.id]: next }));
    }

    function describe() {
        const lines = changed.map(role => {
            const before = role.permissions;
            const after = edits[role.id];
            const removed = POWERS.filter(p => has(before, p.perm) && !has(after, p.perm)).map(p => p.perm);
            const added = POWERS.filter(p => !has(before, p.perm) && has(after, p.perm)).map(p => p.perm);
            const parts = [
                removed.length ? `take away ${list(removed.map(prettyPerm))}` : "",
                added.length ? `give ${list(added.map(prettyPerm))}` : ""
            ].filter(Boolean);
            return `${role.id === guild.id ? "@everyone" : role.name}: ${parts.join(" and ")}`;
        });

        if (dropped.length) {
            lines.push(`Take ${list(dropped.map(id => roles.get(id)?.name ?? id))} away from ${name}`);
        }
        return lines;
    }

    async function apply() {
        setBusy(true);
        const kept = (member?.roles ?? []).filter(id => !dropped.includes(id));

        // filled as each write lands rather than all at the end, so a failure part
        // way through still leaves an undo for whatever already went through
        const targets: Target[] = [];

        try {
            for (const role of changed) {
                await RestAPI.patch({
                    url: `/guilds/${guild.id}/roles/${role.id}`,
                    body: { permissions: String(edits[role.id]) }
                });
                targets.push({
                    kind: "role",
                    roleId: role.id,
                    name: role.id === guild.id ? "@everyone" : role.name,
                    before: String(role.permissions),
                    after: String(edits[role.id])
                });
            }

            if (dropped.length) {
                await RestAPI.patch({
                    url: `/guilds/${guild.id}/members/${userId}`,
                    body: { roles: kept }
                });
                targets.push({
                    kind: "memberRoles",
                    userId,
                    name,
                    before: member?.roles ?? [],
                    after: kept
                });
            }

            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS,
                message: "Saved"
            });
            modalProps.onClose();
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
            setBusy(false);
        } finally {
            if (targets.length) {
                await record({ guildId: guild.id, guildName: guild.name, what: describe().join(". "), targets });
            }
        }
    }

    function confirm() {
        Alerts.show({
            title: "Apply these changes?",
            body: (
                <div>
                    {describe().map(line => <p key={line}>{line}</p>)}
                    {changed.length > 0 && (
                        <p><strong>Permission changes apply to the role, so they affect everyone who holds it, not just {name}.</strong></p>
                    )}
                </div>
            ),
            confirmText: "Apply",
            confirmColor: Button.Colors.RED,
            cancelText: "Cancel",
            onConfirm: apply
        });
    }

    return (
        <Modal
            {...modalProps}
            size="md"
            title={
                <div className={cl("power-head")}>
                    {user && <img className={cl("power-avatar")} src={user.getAvatarURL(guild.id, 80)} alt="" />}
                    <Forms.FormTitle tag="h5" className={cl("power-name")}>What {name} can do here</Forms.FormTitle>
                </div>
            }
        >
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {owner
                            ? "They own the server, so nothing here limits them."
                            : admin
                                ? "They have Administrator, so every channel override is ignored for them."
                                : `They see ${visible.length} of ${plural(channels.length, "channel")} and can post in ${postable.length}.`}
                    </Text>
                    <Text variant="text-sm/normal">
                        {held.length ? `Roles: ${list(held.map(role => role.name))}.` : "They hold no roles beyond @everyone."}
                    </Text>
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
                                {list(postable.map(c => `#${c.name}`)) || "nothing"}
                            </div>
                            <div>
                                <span className={cl("safety-channels-label")}>Can only read</span>
                                {list(readOnly.map(c => `#${c.name}`)) || "nothing"}
                            </div>
                            <div>
                                <span className={cl("safety-channels-label")}>Cannot see</span>
                                {list(hidden.map(c => `#${c.name}`)) || "nothing"}
                            </div>
                        </div>
                    )}

                    {canModerate(guild) && userId !== me && (
                        <Button
                            className={cl("safety-toggle")}
                            size={Button.Sizes.SMALL}
                            look={Button.Looks.LINK}
                            onClick={() => openPunishModal(guild, userId)}
                        >
                            Act on them
                        </Button>
                    )}
                    <Text variant="text-sm/normal">
                        {owner || theirTop > myTop
                            ? "They outrank you, so you cannot remove their roles or moderate them."
                            : theirTop === myTop
                                ? "You and they sit at the same height, so neither of you can touch the other's roles."
                                : "You outrank them."}
                    </Text>
                </div>

                <ScrollerThin className={cl("scroller")} orientation="vertical">
                    {!powers.length ? (
                        <div className={cl("safety-clear")}>
                            <Text variant="text-md/semibold">No special power</Text>
                            <Text variant="text-sm/normal">They can talk where they are allowed to talk, and nothing else.</Text>
                        </div>
                    ) : (
                        powers.map(power => (
                            <div key={power.perm} className={cl("safety-row", { critical: power.perm === "ADMINISTRATOR" })}>
                                <div className={cl("safety-title")}>They can {power.label}</div>
                            </div>
                        ))
                    )}

                    {!admin && moderating.length > 0 && moderating.length < channels.length && (
                        <div className={cl("safety-row")}>
                            <div className={cl("safety-title")}>They can delete messages in {plural(moderating.length, "channel")}</div>
                            <div className={cl("safety-detail")}>{list(moderating.map(c => `#${c.name}`))}</div>
                        </div>
                    )}

                    {sources.map(role => {
                        const editable = canEdit(role);
                        const isEveryone = role.id === guild.id;

                        return (
                            <div key={role.id} className={cl("power-role")}>
                                <div className={cl("safety-title")}>
                                    {isEveryone ? "@everyone" : role.name}
                                    {!editable && <span className={cl("power-locked")}>you cannot edit this role</span>}
                                </div>

                                {POWERS.filter(power => has(role.permissions, power.perm) || has(permsOf(role), power.perm)).map(power => (
                                    <FormSwitch
                                        key={power.perm}
                                        hideBorder
                                        title={prettyPerm(power.perm)}
                                        value={has(permsOf(role), power.perm)}
                                        disabled={!editable || busy}
                                        onChange={on => toggle(role, power.perm, on)}
                                    />
                                ))}

                                {!isEveryone && (
                                    <FormSwitch
                                        hideBorder
                                        title={`${name} keeps this role`}
                                        value={!dropped.includes(role.id)}
                                        disabled={!canManage || role.managed || (!iOwn && role.position >= myTop) || busy}
                                        description={role.managed ? "A bot or boost role, which cannot be taken away by hand" : undefined}
                                        onChange={keep => setDropped(prev => keep ? prev.filter(id => id !== role.id) : [...prev, role.id])}
                                    />
                                )}
                            </div>
                        );
                    })}
                </ScrollerThin>

                {dirty && (
                    <div className={cl("power-apply")}>
                        <Text variant="text-sm/normal">Nothing has been sent yet.</Text>
                        <div className={cl("safety-actions-right")}>
                            <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} disabled={busy} onClick={() => { setEdits({}); setDropped([]); }}>
                                Discard
                            </Button>
                            <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} disabled={busy} onClick={confirm}>
                                Apply
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
}

export function openMemberPowerModal(guild: Guild, userId: string) {
    openModal(props => <MemberPower guild={guild} userId={userId} modalProps={props} />);
}
