/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, Permissions, RenderModalProps, Role } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildRoleStore, Modal, openModal, PermissionsBits, RestAPI, ScrollerThin, Select, Text, Toasts, UserStore, useState } from "@webpack/common";

import { record, Target } from "./History";
import { myPermissions, topRole } from "./moderation";
import { everyoneIn, guildChannels, has, list, plural, prettyPerm } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const SLOWMODE = [
    { label: "off", value: 0 },
    { label: "5 seconds", value: 5 },
    { label: "10 seconds", value: 10 },
    { label: "30 seconds", value: 30 },
    { label: "1 minute", value: 60 },
    { label: "5 minutes", value: 300 },
    { label: "15 minutes", value: 900 }
];

const STRIPPABLE: Permissions[] = [
    "MANAGE_GUILD",
    "MANAGE_ROLES",
    "MANAGE_CHANNELS",
    "MANAGE_WEBHOOKS",
    "BAN_MEMBERS",
    "KICK_MEMBERS",
    "MODERATE_MEMBERS",
    "MANAGE_MESSAGES",
    "MENTION_EVERYONE",
    "MANAGE_GUILD_EXPRESSIONS",
    "MOVE_MEMBERS",
    "SEND_TTS_MESSAGES"
];

function Bulk({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const [seconds, setSeconds] = useState(5);
    const [perm, setPerm] = useState<Permissions>("MANAGE_WEBHOOKS");
    const [busy, setBusy] = useState(false);

    const mine = myPermissions(guild);
    const iOwn = guild.ownerId === UserStore.getCurrentUser().id;
    const myTop = topRole(guild, UserStore.getCurrentUser().id);

    const everyone = GuildRoleStore.getSortedRoles(guild.id).find(role => role.id === guild.id);

    // only text channels carry a rate limit; a voice channel reads back undefined,
    // which compares unequal to every value and would queue a pointless request
    const postable = everyone
        ? guildChannels(guild.id).filter(channel => {
            if (channel.type !== 0 && channel.type !== 5) return false;

            const permissions = everyoneIn(channel, guild.id, everyone.permissions);
            return has(permissions, "VIEW_CHANNEL") && has(permissions, "SEND_MESSAGES");
        })
        : [];

    const changing = postable.filter(channel => channel.rateLimitPerUser !== seconds);

    const holders = GuildRoleStore.getSortedRoles(guild.id)
        .filter(role => role.id !== guild.id && has(role.permissions, perm));
    const editable = holders.filter(role => iOwn || role.position < myTop);
    const locked = holders.filter(role => !editable.includes(role));

    async function run(label: string, action: () => Promise<void>) {
        setBusy(true);
        try {
            await action();
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: label });
            modalProps.onClose();
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
            setBusy(false);
        }
    }

    async function sweepSlowmode() {
        const targets: Target[] = [];
        const label = SLOWMODE.find(option => option.value === seconds)?.label;

        try {
            for (const channel of changing) {
                await RestAPI.patch({ url: `/channels/${channel.id}`, body: { rate_limit_per_user: seconds } });
                targets.push({
                    kind: "slowmode",
                    channelId: channel.id,
                    name: channel.name,
                    before: channel.rateLimitPerUser ?? 0,
                    after: seconds
                });
            }
        } finally {
            // whatever landed before a failure is still a change somebody has to be
            // able to take back, so it goes in the log either way
            if (targets.length) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Set slowmode to ${label} in ${plural(targets.length, "channel")}`,
                    targets
                });
            }
        }
    }

    async function strip() {
        const bit = PermissionsBits[perm];
        if (typeof bit !== "bigint") return;

        const targets: Target[] = [];

        try {
            for (const role of editable) {
                const after = role.permissions & ~bit;
                await RestAPI.patch({ url: `/guilds/${guild.id}/roles/${role.id}`, body: { permissions: String(after) } });
                targets.push({
                    kind: "role",
                    roleId: role.id,
                    name: role.name,
                    before: String(role.permissions),
                    after: String(after)
                });
            }
        } finally {
            if (targets.length) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Took ${prettyPerm(perm)} away from ${plural(targets.length, "role")}`,
                    targets
                });
            }
        }
    }

    const roleName = (role: Role) => role.name;

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Change a lot at once in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">Both of these are one History entry, so one undo puts the whole sweep back.</Text>
                    <Text variant="text-sm/normal">Each channel and each role is a separate request, so a big server takes a moment.</Text>
                </div>

                <ScrollerThin className={cl("scroller")} orientation="vertical">
                    <div className={cl("punish-cell")}>
                        <div className={cl("punish-head")}>
                            <div className={cl("safety-title")}>Slowmode everywhere</div>
                            <div className={cl("punish-controls")}>
                                <div className={cl("punish-select")}>
                                    <Select
                                        options={SLOWMODE}
                                        select={setSeconds}
                                        isSelected={value => value === seconds}
                                        serialize={String}
                                    />
                                </div>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    className={cl("punish-go")}
                                    disabled={busy || !changing.length || !has(mine, "MANAGE_CHANNELS")}
                                    onClick={() => Alerts.show({
                                        title: "Set slowmode?",
                                        body: <p>{plural(changing.length, "channel")} will change. {list(changing.map(c => `#${c.name}`))}.</p>,
                                        confirmText: "Do it",
                                        confirmColor: Button.Colors.RED,
                                        cancelText: "Cancel",
                                        onConfirm: () => run("Slowmode set", sweepSlowmode)
                                    })}
                                >
                                    Apply
                                </Button>
                            </div>
                        </div>
                        <div className={cl("safety-detail")}>
                            {changing.length
                                ? `${changing.length} of the ${postable.length} channels anyone can post in are not set to that yet. Slowmode makes each person wait between messages, so a flood becomes a trickle without anyone losing the ability to talk. Only text and announcement channels are touched.`
                                : `All ${plural(postable.length, "channel")} anyone can post in are already set to that, so there is nothing to send.`}
                        </div>
                    </div>

                    <div className={cl("punish-cell", "punish-danger")}>
                        <div className={cl("punish-head")}>
                            <div className={cl("safety-title")}>Take a permission off every role</div>
                            <div className={cl("punish-controls")}>
                                <div className={cl("punish-select")}>
                                    <Select
                                        options={STRIPPABLE.map(p => ({ label: prettyPerm(p), value: p }))}
                                        select={setPerm}
                                        isSelected={value => value === perm}
                                        serialize={String}
                                    />
                                </div>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    className={cl("punish-go")}
                                    color={Button.Colors.RED}
                                    disabled={busy || !editable.length || !has(mine, "MANAGE_ROLES")}
                                    onClick={() => Alerts.show({
                                        title: `Take ${prettyPerm(perm)} away?`,
                                        body: <p>{list(editable.map(roleName))} will lose it. Everyone holding those roles is affected, not just one person.</p>,
                                        confirmText: "Do it",
                                        confirmColor: Button.Colors.RED,
                                        cancelText: "Cancel",
                                        onConfirm: () => run("Permission removed", strip)
                                    })}
                                >
                                    Strip it
                                </Button>
                            </div>
                        </div>
                        <div className={cl("safety-detail")}>
                            {holders.length
                                ? `${list(holders.map(roleName))} hold ${prettyPerm(perm)}. Taking it away changes the role itself, so it affects every single person who has that role, not one member. This is the fast way to close a hole you have just found, and one undo in History puts all of them back.`
                                : `No role has ${prettyPerm(perm)}, so there is nothing here to take away.`}
                        </div>
                        {locked.length > 0 && (
                            <div className={cl("joins-flags")}>
                                {list(locked.map(roleName))} sit at or above your own highest role, so they are left alone.
                            </div>
                        )}
                    </div>
                </ScrollerThin>
            </div>
        </Modal>
    );
}

export function openBulkModal(guild: Guild) {
    openModal(props => <Bulk guild={guild} modalProps={props} />);
}
