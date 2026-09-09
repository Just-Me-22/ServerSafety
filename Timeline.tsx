/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildRoleStore, Modal, openModal, ScrollerThin, Text, Toasts, useEffect, useState } from "@webpack/common";

import { guildChannels, has, list, permNames, plural, prettyPerm } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const KEEP = 24;
const key = (guildId: string) => `serverSafety-timeline-${guildId}`;

interface Mark {
    at: number;
    verification: number;
    filter: number;
    roles: Record<string, { name: string; permissions: string; }>;
    channels: Record<string, string>;
    admins: string[];
}

const readMarks = async (guildId: string) => (await DataStore.get<Mark[]>(key(guildId))) ?? [];

function takeMark(guild: Guild): Mark {
    const roles = GuildRoleStore.getSortedRoles(guild.id);

    return {
        at: Date.now(),
        verification: guild.verificationLevel,
        filter: guild.explicitContentFilter,
        roles: Object.fromEntries(roles.map(role => [role.id, { name: role.name, permissions: String(role.permissions) }])),
        channels: Object.fromEntries(guildChannels(guild.id).map(channel => [channel.id, channel.name])),
        admins: roles.filter(role => has(role.permissions, "ADMINISTRATOR")).map(role => role.name)
    };
}

const LEVELS = ["None", "Low", "Medium", "High", "Highest"];
const FILTERS = ["nobody", "members without a role", "everyone"];

/** what changed between two marks, in the words you would use to describe it */
function drift(before: Mark, after: Mark): string[] {
    const lines: string[] = [];

    if (before.verification !== after.verification) {
        lines.push(`verification went from ${LEVELS[before.verification]} to ${LEVELS[after.verification]}`);
    }
    if (before.filter !== after.filter) {
        lines.push(`media scanning went from ${FILTERS[before.filter]} to ${FILTERS[after.filter]}`);
    }

    const added = Object.keys(after.roles).filter(id => !before.roles[id]);
    const gone = Object.keys(before.roles).filter(id => !after.roles[id]);
    if (added.length) lines.push(`${plural(added.length, "role")} added: ${list(added.map(id => after.roles[id].name))}`);
    if (gone.length) lines.push(`${plural(gone.length, "role")} deleted: ${list(gone.map(id => before.roles[id].name))}`);

    for (const [id, now] of Object.entries(after.roles)) {
        const was = before.roles[id];
        if (!was) continue;

        if (was.name !== now.name) lines.push(`${was.name} was renamed to ${now.name}`);
        if (was.permissions === now.permissions) continue;

        const gained = permNames(BigInt(now.permissions) & ~BigInt(was.permissions));
        const lost = permNames(BigInt(was.permissions) & ~BigInt(now.permissions));

        if (gained.length) lines.push(`${now.name} gained ${list(gained.map(prettyPerm))}`);
        if (lost.length) lines.push(`${now.name} lost ${list(lost.map(prettyPerm))}`);
    }

    const newChannels = Object.keys(after.channels).filter(id => !before.channels[id]);
    const goneChannels = Object.keys(before.channels).filter(id => !after.channels[id]);
    if (newChannels.length) lines.push(`${plural(newChannels.length, "channel")} added: ${list(newChannels.map(id => `#${after.channels[id]}`))}`);
    if (goneChannels.length) lines.push(`${plural(goneChannels.length, "channel")} deleted: ${list(goneChannels.map(id => `#${before.channels[id]}`))}`);

    return lines;
}

function Timeline({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const [marks, setMarks] = useState<Mark[]>();
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let alive = true;
        readMarks(guild.id).then(found => { if (alive) setMarks(found); });
        return () => { alive = false; };
    }, [guild.id]);

    async function save() {
        setBusy(true);
        const next = [takeMark(guild), ...(marks ?? [])].slice(0, KEEP);
        await DataStore.set(key(guild.id), next);
        setMarks(next);
        setBusy(false);
        Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Saved how it looks now" });
    }

    async function clear() {
        await DataStore.set(key(guild.id), []);
        setMarks([]);
    }

    const now = takeMark(guild);
    const sinceLast = marks?.length ? drift(marks[0], now) : [];

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">How {guild.name} has changed</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!marks
                            ? "Reading..."
                            : marks.length
                                ? sinceLast.length
                                    ? `${plural(sinceLast.length, "thing")} has changed since ${new Date(marks[0].at).toLocaleString()}.`
                                    : `Nothing has changed since ${new Date(marks[0].at).toLocaleString()}.`
                                : "Nothing saved yet."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Save one now and again, and this shows what moved between them. It only sees what
                        you saved, so it starts empty and fills up. The last {KEEP} are kept.
                    </Text>
                </div>

                {sinceLast.length > 0 && (
                    <div className={cl("safety-row", "critical")}>
                        <div className={cl("safety-title")}>Since the last save</div>
                        <div className={cl("safety-detail")}>
                            {sinceLast.map(line => <div key={line}>{line}</div>)}
                        </div>
                    </div>
                )}

                {marks && marks.length > 1 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {marks.slice(0, -1).map((mark, i) => {
                            const changes = drift(marks[i + 1], mark);
                            return (
                                <div key={mark.at} className={cl("safety-row")}>
                                    <div className={cl("safety-title")}>{new Date(mark.at).toLocaleString()}</div>
                                    <div className={cl("safety-detail")}>
                                        {changes.length
                                            ? changes.map(line => <div key={line}>{line}</div>)
                                            : <div>nothing moved since the one before it</div>}
                                    </div>
                                </div>
                            );
                        })}
                    </ScrollerThin>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {marks?.length
                            ? `${plural(marks.length, "save")}, ${now.admins.length} of the roles carry Administrator right now`
                            : "nothing saved yet"}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        {marks && marks.length > 0 && (
                            <Button
                                size={Button.Sizes.SMALL}
                                look={Button.Looks.LINK}
                                className={cl("safety-panic")}
                                onClick={() => Alerts.show({
                                    title: "Throw the history away?",
                                    body: <p>Every saved point for this server goes, and drift starts again from nothing.</p>,
                                    confirmText: "Throw it away",
                                    confirmColor: Button.Colors.RED,
                                    cancelText: "Cancel",
                                    onConfirm: () => void clear()
                                })}
                            >
                                Forget all of it
                            </Button>
                        )}
                        <Button size={Button.Sizes.SMALL} disabled={busy} onClick={save}>
                            Save how it looks now
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openTimelineModal(guild: Guild) {
    openModal(props => <Timeline guild={guild} modalProps={props} />);
}
