/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps, Role } from "@vencord/discord-types";
import { Forms, GuildRoleStore, Modal, openModal, ScrollerThin, Text } from "@webpack/common";

import { has, list, plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

interface Rung {
    role: Role;
    reach: Role[];
    admin: boolean;
}

/** discord's rule: manage roles lets you hand out and edit anything strictly below your
 *  own highest role. administrator skips the check and reaches everything under it. */
function ladder(guild: Guild): Rung[] {
    const roles = GuildRoleStore.getSortedRoles(guild.id).filter(role => role.id !== guild.id);

    return roles
        .map(role => {
            const admin = has(role.permissions, "ADMINISTRATOR");
            if (!admin && !has(role.permissions, "MANAGE_ROLES")) return null;

            return {
                role,
                admin,
                reach: roles.filter(other => other.position < role.position)
            };
        })
        .filter((rung): rung is Rung => rung != null)
        .sort((a, b) => b.role.position - a.role.position);
}

function Ladder({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const rungs = ladder(guild);
    const all = GuildRoleStore.getSortedRoles(guild.id).filter(role => role.id !== guild.id);
    const admins = rungs.filter(rung => rung.admin);

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Who can hand out what in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {rungs.length
                            ? `${plural(rungs.length, "role")} of ${all.length} can hand out other roles.`
                            : "No role here can hand out another."}
                    </Text>
                    <Text variant="text-sm/normal">
                        A role reaches everything below its own place in the list, never its own level or above.
                        {admins.length ? ` ${plural(admins.length, "role")} carry Administrator, which reaches everything under it whatever else it says.` : ""}
                    </Text>
                </div>

                {rungs.length > 0 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {rungs.map(rung => (
                            <div key={rung.role.id} className={cl("safety-row", { critical: rung.admin })}>
                                <div className={cl("safety-title")}>
                                    {rung.role.name}
                                    {rung.admin && <span className={cl("power-locked")}>administrator</span>}
                                </div>
                                <div className={cl("safety-detail")}>
                                    {rung.reach.length
                                        ? `reaches ${plural(rung.reach.length, "role")}: ${list(rung.reach.map(role => role.name))}`
                                        : "sits at the bottom, so it reaches nothing"}
                                </div>
                            </div>
                        ))}
                    </ScrollerThin>
                )}
            </div>
        </Modal>
    );
}

export function openLadderModal(guild: Guild) {
    openModal(props => <Ladder guild={guild} modalProps={props} />);
}
