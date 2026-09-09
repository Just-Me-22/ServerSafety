/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Alerts, Button, Forms, Modal, openModal, RestAPI, ScrollerThin, Text, Toasts, useEffect, useState } from "@webpack/common";

import { arrivals, note } from "./arrivals";
import { everyone, syncFromAuditLog } from "./departures";
import { record } from "./History";
import { describeInvite, fetchInvites, Invite } from "./invites";
import { arrivalsIn, RawMember, searchMembers } from "./RecentJoins";
import { plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

interface Row {
    code: string;
    brought: number;
    here: number;
    punished: number;
    invite: Invite | null;
    vanity: boolean;
}

function rank(a: Row, b: Row) {
    if (a.punished !== b.punished) return b.punished - a.punished;

    const rate = (row: Row) => row.brought ? row.punished / row.brought : 0;
    if (rate(a) !== rate(b)) return rate(b) - rate(a);

    return b.brought - a.brought;
}

function Invites({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const [rows, setRows] = useState<Row[]>();
    const [gaps, setGaps] = useState<string[]>([]);
    const [open, setOpen] = useState<string>();
    const [busy, setBusy] = useState(false);

    async function build() {
        const missing: string[] = [];

        const invites = await fetchInvites(guild.id);
        if (!invites) missing.push("Manage Server, so the invite list itself is hidden");

        let members: RawMember[] = [];
        try {
            members = await searchMembers(guild.id, 1000);
            await note(guild.id, arrivalsIn(members));
        } catch {
            missing.push("a moderator permission, so nobody currently here could be counted");
        }

        if (await syncFromAuditLog(guild.id) === "denied") {
            missing.push("View Audit Log, so only the bans and kicks made through here are counted");
        }

        const [seen, gone] = await Promise.all([arrivals(guild.id), everyone(guild.id)]);
        const present = new Set(members.map(entry => entry.member.user.id));

        const byCode = new Map<string, string[]>();
        for (const [userId, arrival] of Object.entries(seen)) {
            byCode.set(arrival.code, [...byCode.get(arrival.code) ?? [], userId]);
        }

        for (const code of invites?.keys() ?? []) {
            if (!byCode.has(code)) byCode.set(code, []);
        }

        const built = [...byCode].map(([code, users]): Row => ({
            code,
            brought: users.length,
            here: users.filter(userId => present.has(userId)).length,
            punished: users.filter(userId => gone[userId]).length,
            invite: invites?.get(code) ?? null,
            vanity: code === guild.vanityURLCode
        }));

        return { built: built.sort(rank), missing };
    }

    useEffect(() => {
        let alive = true;
        build().then(({ built, missing }) => {
            if (!alive) return;
            setRows(built);
            setGaps(missing);
        });
        return () => { alive = false; };
    }, [guild.id]);

    async function remove(row: Row) {
        setBusy(true);
        try {
            await RestAPI.del({ url: `/invites/${row.code}` });
            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: `Deleted invite ${row.code}. A code cannot be brought back.`,
                targets: []
            });
            setRows(current => current?.map(one => one.code === row.code ? { ...one, invite: null } : one));
            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: `${row.code} is gone` });
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

    const worst = rows?.filter(row => row.punished > 0) ?? [];

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Invites into {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {!rows
                            ? "Working it out..."
                            : worst.length
                                ? `${plural(worst.length, "invite")} brought someone who was later kicked or banned.`
                                : "No invite here has brought anyone who was later kicked or banned."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Counts only cover joins this has seen. It learns more every time you open Recent joins.
                    </Text>
                    {gaps.length > 0 && (
                        <Text variant="text-sm/normal">You are missing {gaps.join(", and ")}.</Text>
                    )}
                </div>

                {rows && rows.length > 0 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {rows.map(row => (
                            <div key={row.code} className={cl("safety-row", { critical: row.punished > 0 })}>
                                <div className={cl("safety-title")}>
                                    {row.code}
                                    {row.vanity && <span className={cl("power-locked")}>vanity</span>}
                                    {!row.invite && !row.vanity && <span className={cl("power-locked")}>deleted</span>}
                                </div>
                                <div className={cl("safety-detail")}>
                                    {row.brought
                                        ? `${plural(row.brought, "join")} tracked, ${row.here} still here, ${row.punished} kicked or banned`
                                        : "no tracked joins"}
                                </div>

                                {open === row.code && row.invite && (
                                    <div className={cl("joins-detail")}>
                                        {describeInvite(row.invite).map(line => <div key={line}>{line}</div>)}
                                    </div>
                                )}

                                <div className={cl("safety-row-actions")}>
                                    {row.invite && (
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            onClick={() => setOpen(open === row.code ? undefined : row.code)}
                                        >
                                            {open === row.code ? "Less" : "More"}
                                        </Button>
                                    )}
                                    {row.invite && !row.vanity && (
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            className={cl("safety-panic")}
                                            disabled={busy}
                                            onClick={() => Alerts.show({
                                                title: `Delete ${row.code}?`,
                                                body: <p>Anyone holding the link loses it, and the code cannot be made again.</p>,
                                                confirmText: "Delete it",
                                                confirmColor: Button.Colors.RED,
                                                cancelText: "Cancel",
                                                onConfirm: () => void remove(row)
                                            })}
                                        >
                                            Delete invite
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </ScrollerThin>
                )}
            </div>
        </Modal>
    );
}

export function openInvitesModal(guild: Guild) {
    openModal(props => <Invites guild={guild} modalProps={props} />);
}
