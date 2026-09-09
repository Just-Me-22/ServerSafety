/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Button, ChannelStore, Checkbox, Forms, GuildMemberStore, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Text, Toasts, useEffect, useState } from "@webpack/common";

import { confirmBulk } from "./confirm";
import { record } from "./History";
import { plural } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

const GAP = 400;

const KIND: Record<number, string> = {
    1: "posts into the channel",
    2: "reposts another server's announcements",
    3: "belongs to an app"
};

interface Raw {
    id: string;
    type: number;
    name: string;
    channel_id: string;
    application_id?: string | null;
    user?: { id: string; username: string; global_name?: string | null; } | null;
    source_guild?: { name: string; } | null;
}

interface Hook {
    id: string;
    name: string;
    channel: string;
    kind: string;
    by: string;
    flags: string[];
}

function toHooks(guild: Guild, raw: Raw[]): Hook[] {
    return raw
        .map(hook => {
            const channel = ChannelStore.getChannel(hook.channel_id);
            const maker = hook.user;
            const flags: string[] = [];

            if (maker && !GuildMemberStore.getMember(guild.id, maker.id)) flags.push("whoever made it has left");
            if (!channel) flags.push("its channel is gone");
            if (hook.type === 2) flags.push(`follows ${hook.source_guild?.name ?? "another server"}`);

            return {
                id: hook.id,
                name: hook.name || "unnamed",
                channel: channel ? `#${channel.name}` : "a channel you cannot see",
                kind: KIND[hook.type] ?? "unknown kind",
                by: maker ? maker.global_name || maker.username : "an app",
                flags
            };
        })
        .sort((a, b) => b.flags.length - a.flags.length);
}

function Webhooks({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const allowed = PermissionStore.can(PermissionsBits.MANAGE_WEBHOOKS, guild);

    const [hooks, setHooks] = useState<Hook[]>();
    const [denied, setDenied] = useState(false);
    const [ticked, setTicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>();

    async function load() {
        try {
            const { body } = await RestAPI.get({ url: `/guilds/${guild.id}/webhooks` });
            return toHooks(guild, body as Raw[]);
        } catch {
            setDenied(true);
            return [];
        }
    }

    useEffect(() => {
        let alive = true;
        load().then(found => { if (alive) setHooks(found); });
        return () => { alive = false; };
    }, [guild.id]);

    const tick = (id: string) => setTicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    const chosen = hooks?.filter(hook => ticked.has(hook.id)) ?? [];
    const flagged = hooks?.filter(hook => hook.flags.length).length ?? 0;

    async function remove() {
        setBusy(true);
        let done = 0;

        try {
            for (const hook of chosen) {
                await RestAPI.del({ url: `/webhooks/${hook.id}` });
                done++;
                setProgress(`deleted ${done} of ${chosen.length}`);
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
                    what: `Deleted ${plural(done, "webhook")}. Anything posting through them stops.`,
                    targets: []
                });
            }
            setProgress(undefined);
            setBusy(false);
            setTicked(new Set());
            setHooks(await load());
        }
    }

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Webhooks in {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("safety-summary")}>
                    <Text variant="text-md/semibold">
                        {denied || !allowed
                            ? "You need Manage Webhooks here."
                            : !hooks
                                ? "Asking Discord..."
                                : hooks.length
                                    ? `${plural(hooks.length, "webhook")}, ${flagged} worth a look.`
                                    : "No webhooks in this server."}
                    </Text>
                    <Text variant="text-sm/normal">
                        Anyone holding a webhook URL can post here under any name and picture, without being a member.
                    </Text>
                </div>

                {hooks && hooks.length > 0 && (
                    <ScrollerThin className={cl("scroller")} orientation="vertical">
                        {hooks.map(hook => (
                            <div key={hook.id} className={cl("safety-row", { critical: hook.flags.length > 0 })}>
                                <Checkbox
                                    value={ticked.has(hook.id)}
                                    onChange={() => tick(hook.id)}
                                    disabled={busy || !allowed}
                                    align="top"
                                >
                                    <div className={cl("safety-title")}>{hook.name}</div>
                                    <div className={cl("safety-detail")}>
                                        {hook.channel}, {hook.kind}, made by {hook.by}
                                    </div>
                                    {hook.flags.length > 0 && <div className={cl("joins-flags")}>{hook.flags.join(", ")}</div>}
                                </Checkbox>
                            </div>
                        ))}
                    </ScrollerThin>
                )}

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {progress || (chosen.length ? `${plural(chosen.length, "webhook")} ticked` : "nothing ticked")}
                    </Text>
                    <div className={cl("safety-actions-right")}>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.RED}
                            disabled={busy || !allowed || !chosen.length}
                            onClick={() => confirmBulk({
                                title: `Delete ${plural(chosen.length, "webhook")}?`,
                                items: chosen.map(hook => `${hook.name} in ${hook.channel}`),
                                warning: "Anything posting through them stops, and the URLs stop working.",
                                verb: "Delete them",
                                onConfirm: () => void remove()
                            })}
                        >
                            Delete ticked
                        </Button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

export function openWebhooksModal(guild: Guild) {
    openModal(props => <Webhooks guild={guild} modalProps={props} />);
}
