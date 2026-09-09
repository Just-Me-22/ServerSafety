/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { openUserProfile } from "@utils/discord";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, Checkbox, Forms, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Text, Toasts, useEffect, useState } from "@webpack/common";

import { forget } from "./cache";
import { confirmBulk } from "./confirm";
import { record, Target } from "./History";
import { RawMember, searchMembers } from "./RecentJoins";
import { list, plural } from "./SafetyTab";
import { clean, combiningCount, invisibleCount, lookalikeCount } from "./text";

const cl = classNameFactory("vc-ss-");

const GAP = 400;
const ZALGO = 6;

/** characters that sort above letters, so a name starting with one sits at the top of
 *  every list. one is a choice, a row of them is a land grab. */
const HOISTING = /^[^\p{L}\p{N}]{2,}/u;

interface Row {
    userId: string;
    was: string;
    becomes: string;
    why: string[];
}

function look(raw: RawMember[]): Row[] {
    const out: Row[] = [];

    for (const entry of raw) {
        const was = entry.member.nick || entry.member.user.global_name || entry.member.user.username;
        const why: string[] = [];

        const invisible = invisibleCount(was);
        const combining = combiningCount(was);
        const lookalikes = lookalikeCount(was);

        if (invisible) why.push(`${plural(invisible, "invisible character")}`);
        if (combining >= ZALGO) why.push(`${plural(combining, "stacked mark")}`);
        if (lookalikes >= 2) why.push(`${plural(lookalikes, "letter")} from another alphabet`);
        if (HOISTING.test(was)) why.push("starts with symbols to sit at the top of the list");

        if (!why.length) continue;

        const becomes = clean(was);
        if (!becomes || becomes === was) continue;

        out.push({ userId: entry.member.user.id, was, becomes, why });
    }

    return out.sort((a, b) => b.why.length - a.why.length);
}

function Nicknames({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const allowed = PermissionStore.can(PermissionsBits.MANAGE_NICKNAMES, guild);

    const [rows, setRows] = useState<Row[]>();
    const [denied, setDenied] = useState(false);
    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();

    async function load() {
        const raw = await searchMembers(guild.id, 1000);
        return look(raw);
    }

    useEffect(() => {
        let alive = true;
        load()
            .then(found => { if (alive) setRows(found); })
            .catch(() => { if (alive) setDenied(true); });
        return () => { alive = false; };
    }, [guild.id]);

    const tick = (id: string) => setTicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    const chosen = rows?.filter(row => ticked.has(row.userId)) ?? [];

    async function apply() {
        setBusy(true);
        let done = 0;
        const targets: Target[] = [];

        try {
            for (const row of chosen) {
                await RestAPI.patch({
                    url: `/guilds/${guild.id}/members/${row.userId}`,
                    body: { nick: row.becomes }
                });

                targets.push({ kind: "nick", userId: row.userId, name: row.becomes, before: row.was, after: row.becomes });
                done++;
                setProgress(`renamed ${done} of ${chosen.length}`);
                if (done < chosen.length) await new Promise(r => setTimeout(r, GAP));
            }
        } catch (error: any) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Stopped after ${done}: ${error?.body?.message ?? String(error)}`
            });
        } finally {
            if (done) {
                await record({
                    guildId: guild.id,
                    guildName: guild.name,
                    what: `Tidied ${plural(done, "nickname")}`,
                    targets
                });
            }
            setProgress(undefined);
            setBusy(false);
            setTicked(new Set());
            forget(`members:${guild.id}`);
            setRows(await load());
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Nicknames in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {denied
                            ? "You need one of Ban, Kick, Timeout, Manage Roles or Manage Nicknames here."
                            : !rows
                                ? "Reading names..."
                                : rows.length
                                    ? `${plural(rows.length, "name")} carries something worth taking out.`
                                    : "Every name here is plain already."}
                    </Text>
                    <Text variant="text-sm/normal">
                        It strips invisible characters and stacked marks. Letters from other alphabets are
                        flagged but left alone, since plenty of people write their own name that way.
                    </Text>
                    {!allowed && rows && rows.length > 0 && (
                        <Text variant="text-sm/normal">You need Manage Nicknames to change any of these.</Text>
                    )}
                </div>

                {rows && rows.length > 0 && (
                    <>
                        <div className={cl("purge-pick")}>
                            <Text variant="text-sm/normal">{chosen.length} of {rows.length} ticked</Text>
                            <div className={cl("safety-actions-right")}>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.LINK}
                                    disabled={busy}
                                    onClick={() => setTicked(new Set(rows.map(row => row.userId)))}
                                >
                                    Tick all
                                </Button>
                                <Button
                                    size={Button.Sizes.SMALL}
                                    look={Button.Looks.LINK}
                                    disabled={busy || !ticked.size}
                                    onClick={() => setTicked(new Set())}
                                >
                                    Untick all
                                </Button>
                            </div>
                        </div>

                        <ScrollerThin className={cl("scroller")} orientation="vertical">
                            {rows.map(row => (
                                <div key={row.userId} className={cl("safety-row")}>
                                    <Checkbox
                                        value={ticked.has(row.userId)}
                                        onChange={() => tick(row.userId)}
                                        disabled={busy || !allowed}
                                        align="top"
                                    >
                                        <div className={cl("safety-title")}>
                                            {row.was} becomes {row.becomes}
                                        </div>
                                        <div className={cl("safety-detail")}>{list(row.why)}</div>
                                    </Checkbox>
                                    <div className={cl("safety-row-actions")}>
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            look={Button.Looks.LINK}
                                            onClick={() => openUserProfile(row.userId, guild.id)}
                                        >
                                            Open their profile
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </ScrollerThin>
                    </>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (chosen.length ? `${plural(chosen.length, "name")} ticked, undo is in History` : "nothing ticked")}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button
                            size={Button.Sizes.SMALL}
                            disabled={busy || !allowed || !chosen.length}
                            onClick={() => confirmBulk({
                                title: `Rename ${plural(chosen.length, "person")}?`,
                                items: chosen.map(row => `${row.was} becomes ${row.becomes}`),
                                warning: "Their old names are kept in History, so this one can be put back.",
                                verb: "Rename them",
                                onConfirm: () => void apply()
                            })}
                        >
                            Tidy ticked
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openNicknamesModal(guild: Guild) {
    openModal(props => <Nicknames guild={guild} modalProps={props} />);
}
