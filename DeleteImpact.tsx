/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps, Role } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildMemberStore, GuildRoleStore, Modal, openModal, RestAPI, ScrollerThin, Select, Text, Toasts, useEffect, UserStore, useState } from "@webpack/common";

import { record } from "./History";
import { memberIn } from "./MemberPower";
import { savedQuarantineRole } from "./moderation";
import { searchMembers } from "./RecentJoins";
import { guildChannels, has, list, permNames, plural, prettyPerm } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

interface Holder {
    userId: string;
    name: string;
    roles: string[];
}

interface Loss {
    name: string;
    perms: string[];
    channels: string[];
}

interface Impact {
    losses: Loss[];
    holders: number;
    untouched: number;
    closes: string[];
    opens: string[];
    perms: string[];
    quarantine: boolean;
}

function holdersOf(guild: Guild, roleId: string, extra: Holder[]): Holder[] {
    const seen = new Map<string, Holder>();

    for (const member of GuildMemberStore.getMembers(guild.id)) {
        if (member.roles.includes(roleId)) {
            seen.set(member.userId, {
                userId: member.userId,
                name: member.nick || UserStore.getUser(member.userId)?.username || member.userId,
                roles: member.roles
            });
        }
    }

    for (const holder of extra) {
        if (holder.roles.includes(roleId)) seen.set(holder.userId, holder);
    }

    return [...seen.values()];
}

function measure(guild: Guild, role: Role, extra: Holder[], quarantineId: string | null): Impact {
    const roles = new Map(GuildRoleStore.getSortedRoles(guild.id).map(one => [one.id, one]));
    const everyone = roles.get(guild.id)?.permissions ?? 0n;
    const channels = guildChannels(guild.id);

    const closes: string[] = [];
    const opens: string[] = [];

    for (const channel of channels) {
        const overwrite = channel.permissionOverwrites?.[role.id];
        if (!overwrite) continue;

        if (has(overwrite.allow, "VIEW_CHANNEL")) closes.push(channel.name);
        else if (has(overwrite.deny, "VIEW_CHANNEL")) opens.push(channel.name);
    }

    const losses: Loss[] = [];
    let untouched = 0;

    for (const holder of holdersOf(guild, role.id, extra)) {
        const kept = holder.roles.filter(id => id !== role.id);

        let before = everyone;
        for (const id of holder.roles) before |= roles.get(id)?.permissions ?? 0n;

        let after = everyone;
        for (const id of kept) after |= roles.get(id)?.permissions ?? 0n;

        // administrator ignores every channel override, so nothing below applies to them
        const stillAdmin = guild.ownerId === holder.userId || has(after, "ADMINISTRATOR");

        const lost = stillAdmin ? [] : permNames(before & ~after);
        const gone = stillAdmin ? [] : channels.filter(channel => {
            const had = memberIn(channel, guild.id, [guild.id, ...holder.roles], holder.userId, before);
            const left = memberIn(channel, guild.id, [guild.id, ...kept], holder.userId, after);
            return has(had, "VIEW_CHANNEL") && !has(left, "VIEW_CHANNEL");
        }).map(channel => channel.name);

        if (!lost.length && !gone.length) untouched++;
        else losses.push({ name: holder.name, perms: lost, channels: gone });
    }

    losses.sort((a, b) => (b.perms.length + b.channels.length) - (a.perms.length + a.channels.length));

    return {
        losses,
        holders: losses.length + untouched,
        untouched,
        closes,
        opens,
        perms: permNames(role.permissions),
        quarantine: role.id === quarantineId
    };
}

function DeleteImpact({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const roles = GuildRoleStore.getSortedRoles(guild.id).filter(role => role.id !== guild.id);

    const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
    const [extra, setExtra] = useState<Holder[]>([]);
    const [quarantineId, setQuarantineId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;

        searchMembers(guild.id, 1000)
            .then(raw => {
                if (!alive) return;
                setExtra(raw.map(entry => ({
                    userId: entry.member.user.id,
                    name: entry.member.nick || entry.member.user.global_name || entry.member.user.username,
                    roles: entry.member.roles ?? []
                })));
            })
            .catch(() => { });

        savedQuarantineRole(guild.id).then(id => { if (alive) setQuarantineId(id); });

        return () => { alive = false; };
    }, [guild.id]);

    const role = GuildRoleStore.getRole(guild.id, roleId);
    const impact = role ? measure(guild, role, extra, quarantineId) : null;

    async function remove() {
        if (!role) return;
        setBusy(true);
        try {
            await RestAPI.del({ url: `/guilds/${guild.id}/roles/${role.id}` });
            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: `Deleted the role ${role.name}. Its channel rules went with it and cannot be brought back.`,
                targets: []
            });
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: `${role.name} is gone` });
            modalProps.onClose();
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${error?.body?.message ?? String(error)}`
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Deleting a role in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("cast-row")}>
                    <Text variant="text-sm/normal">Role</Text>
                    <Select
                        options={roles.map(one => ({ label: one.name, value: one.id }))}
                        select={(id: string) => setRoleId(id)}
                        isSelected={value => value === roleId}
                        serialize={String}
                    />
                </div>

                {role && impact && (
                    <>
                        <div className={cl("safety-summary")}>
                            <Text variant="text-md/semibold">
                                {impact.losses.length
                                    ? `${plural(impact.losses.length, "person")} would lose something.`
                                    : impact.holders
                                        ? "Nobody holding it would lose anything, because their other roles cover it."
                                        : "Nobody holds this role."}
                            </Text>
                            <Text variant="text-sm/normal">
                                {plural(impact.holders, "person")} checked{impact.untouched ? `, ${impact.untouched} unaffected` : ""}.
                            </Text>
                            {impact.quarantine && (
                                <Text variant="text-sm/normal">This is your quarantine role, so deleting it frees everyone it silenced.</Text>
                            )}
                            {role.managed && (
                                <Text variant="text-sm/normal">This role belongs to a bot or to boosting, so Discord will not let it go by hand.</Text>
                            )}
                        </div>

                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {impact.closes.length > 0 && (
                                <div className={cl("safety-row", "critical")}>
                                    <div className={cl("safety-title")}>{plural(impact.closes.length, "channel")} lose their way in</div>
                                    <div className={cl("safety-detail")}>{list(impact.closes.map(name => `#${name}`))}</div>
                                </div>
                            )}

                            {impact.opens.length > 0 && (
                                <div className={cl("safety-row", "critical")}>
                                    <div className={cl("safety-title")}>{plural(impact.opens.length, "channel")} stop being hidden from it</div>
                                    <div className={cl("safety-detail")}>{list(impact.opens.map(name => `#${name}`))}</div>
                                </div>
                            )}

                            {impact.perms.length > 0 && (
                                <div className={cl("safety-row")}>
                                    <div className={cl("safety-title")}>The role grants {plural(impact.perms.length, "permission")}</div>
                                    <div className={cl("safety-detail")}>{list(impact.perms.map(prettyPerm))}</div>
                                </div>
                            )}

                            {impact.losses.map(loss => (
                                <div key={loss.name} className={cl("safety-row")}>
                                    <div className={cl("safety-title")}>{loss.name}</div>
                                    <div className={cl("safety-detail")}>
                                        {loss.perms.length > 0 && <div>loses {list(loss.perms.map(prettyPerm))}</div>}
                                        {loss.channels.length > 0 && <div>can no longer see {list(loss.channels.map(name => `#${name}`))}</div>}
                                    </div>
                                </div>
                            ))}
                        </ScrollerThin>

                        <div className={cl("power-apply")}>
                            <Text variant="text-sm/normal">
                                {role.managed ? "Discord manages this one" : "There is no undo for this"}
                            </Text>
                            <div className={cl("safety-actions-right")}>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    color={Button.Colors.RED}
                                    disabled={busy || role.managed}
                                    onClick={() => Alerts.show({
                                        title: `Delete ${role.name}?`,
                                        body: (
                                            <div>
                                                <p>
                                                    {plural(impact.losses.length, "person")} lose something and{" "}
                                                    {plural(impact.closes.length, "channel")} lose their way in.
                                                </p>
                                                <p><strong>The role and every channel rule naming it go for good.</strong></p>
                                            </div>
                                        ),
                                        confirmText: "Delete it",
                                        confirmColor: Button.Colors.RED,
                                        cancelText: "Cancel",
                                        onConfirm: () => void remove()
                                    })}
                                >
                                    Delete the role
                                </Button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openDeleteImpactModal(guild: Guild) {
    openModal(props => <DeleteImpact guild={guild} modalProps={props} />);
}
