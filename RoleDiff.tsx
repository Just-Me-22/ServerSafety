/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps, Role } from "@vencord/discord-types";
import { Forms, GuildRoleStore, GuildStore, Modal, openModal, ScrollerThin, Select, Text, useState } from "@webpack/common";

import { permNames, plural, prettyPerm } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

interface Side {
    guildId: string;
    roleId: string;
}

function rolesOf(guildId: string): Role[] {
    return GuildRoleStore.getSortedRoles(guildId).filter(role => role.id !== guildId);
}

function Picker({ label, side, onChange }: { label: string; side: Side; onChange(next: Side): void; }) {
    const guilds = Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name));
    const roles = rolesOf(side.guildId);

    return (
        <div className={cl("diff-side")}>
            <Text variant="text-sm/semibold">{label}</Text>
            <Select
                options={guilds.map(guild => ({ label: guild.name, value: guild.id }))}
                select={(guildId: string) => onChange({ guildId, roleId: rolesOf(guildId)[0]?.id ?? "" })}
                isSelected={value => value === side.guildId}
                serialize={String}
            />
            <Select
                options={roles.map(role => ({ label: role.name, value: role.id }))}
                select={(roleId: string) => onChange({ ...side, roleId })}
                isSelected={value => value === side.roleId}
                serialize={String}
            />
        </div>
    );
}

function Column({ title, names, tone }: { title: string; names: string[]; tone?: string; }) {
    return (
        <div className={cl("diff-column")}>
            <div className={cl("diff-heading", tone)}>{title}</div>
            {names.length
                ? names.map(name => <div key={name} className={cl("diff-perm")}>{prettyPerm(name)}</div>)
                : <div className={cl("diff-perm", "diff-none")}>nothing</div>}
        </div>
    );
}

function RoleDiff({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const here = rolesOf(guild.id);

    const [left, setLeft] = useState<Side>({ guildId: guild.id, roleId: here[0]?.id ?? "" });
    const [right, setRight] = useState<Side>({ guildId: guild.id, roleId: here[1]?.id ?? here[0]?.id ?? "" });

    const a = GuildRoleStore.getRole(left.guildId, left.roleId);
    const b = GuildRoleStore.getRole(right.guildId, right.roleId);

    const onlyA = a && b ? permNames(a.permissions & ~b.permissions) : [];
    const onlyB = a && b ? permNames(b.permissions & ~a.permissions) : [];
    const shared = a && b ? permNames(a.permissions & b.permissions) : [];

    const traits = a && b
        ? [
            a.mentionable !== b.mentionable && `${(a.mentionable ? a : b).name} can be pinged by anyone and ${(a.mentionable ? b : a).name} cannot`,
            a.hoist !== b.hoist && `${(a.hoist ? a : b).name} is shown separately in the member list and ${(a.hoist ? b : a).name} is not`,
            a.managed !== b.managed && `${(a.managed ? a : b).name} belongs to a bot or to boosting, so it cannot be handed out by hand`,
            left.guildId === right.guildId && a.position !== b.position && `${(a.position > b.position ? a : b).name} sits above ${(a.position > b.position ? b : a).name}`
        ].filter(Boolean) as string[]
        : [];

    return (
        <Modal {...modalProps} size="lg" title={<Forms.FormTitle tag="h5">Compare two roles</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("diff-pickers")}>
                    <Picker label="This role" side={left} onChange={setLeft} />
                    <Picker label="Against this one" side={right} onChange={setRight} />
                </div>

                {a && b && (
                    <>
                        <div className={cl("safety-summary")}>
                            <Text variant="text-md/semibold">
                                {onlyA.length || onlyB.length
                                    ? `${plural(onlyA.length + onlyB.length, "permission")} differ, ${shared.length} are the same.`
                                    : "These two grant exactly the same permissions."}
                            </Text>
                            {traits.map(line => <Text key={line} variant="text-sm/normal">{line}.</Text>)}
                        </div>

                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            <div className={cl("diff-grid")}>
                                <Column title={`Only ${a.name}`} names={onlyA} tone="diff-add" />
                                <Column title={`Only ${b.name}`} names={onlyB} tone="diff-remove" />
                                <Column title="Both" names={shared} />
                            </div>
                        </ScrollerThin>
                    </>
                )}
            </div>
        </Modal>
    );
}

export function openRoleDiffModal(guild: Guild) {
    openModal(props => <RoleDiff guild={guild} modalProps={props} />);
}
