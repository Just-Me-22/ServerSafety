/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { classNameFactory } from "@utils/css";
import { Channel, Guild, RenderModalProps, Role } from "@vencord/discord-types";
import { Alerts, Button, Forms, GuildMemberCountStore, GuildRoleStore, Modal, openModal, PermissionsBits, PermissionStore, RestAPI, ScrollerThin, Select, Text, TextInput, Toasts, useEffect, useState } from "@webpack/common";

import { record } from "./History";
import { guildChannels, list, plural } from "./SafetyTab";
import { alertChannel, setAlertChannel } from "./send";
import { deleteTemplate, fill, readTemplates, saveTemplate, Template } from "./templates";

const cl = classNameFactory("vc-ss-");

const TEXTY = new Set([0, 5]);
const MB = 1024 * 1024;

export function sendableChannels(guild: Guild): Channel[] {
    return guildChannels(guild.id)
        .filter(channel => TEXTY.has(channel.type) && PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel));
}

interface Hook {
    id: string;
    name: string;
    token?: string | null;
    channel_id: string;
}

function Broadcast({ guild, initial, modalProps }: { guild: Guild; initial?: string; modalProps: RenderModalProps; }) {
    const channels = sendableChannels(guild);
    const roles = GuildRoleStore.getSortedRoles(guild.id).filter(role => role.id !== guild.id);

    const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
    const [picked, setPicked] = useState<string[]>([]);
    const [everyone, setEveryone] = useState(false);
    const [title, setTitle] = useState("");
    const [body, setBody] = useState(initial ?? "");
    const [files, setFiles] = useState<File[]>([]);
    const [asWebhook, setAsWebhook] = useState(false);
    const [colour, setColour] = useState("#5865f2");
    const [hooks, setHooks] = useState<Hook[]>([]);
    const [hookId, setHookId] = useState("");
    const [templates, setTemplates] = useState<Template[]>([]);
    const [name, setName] = useState("");
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [alertsHere, setAlertsHere] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let live = true;
        readTemplates().then(saved => { if (live) setTemplates(saved); });
        alertChannel(guild.id).then(id => { if (live && id) { setChannelId(id); setAlertsHere(true); } });

        RestAPI.get({ url: `/guilds/${guild.id}/roles/member-counts` })
            .then(({ body }) => { if (live) setCounts(body ?? {}); })
            .catch(() => { /* needs Manage Roles; the composer still works without the numbers */ });

        RestAPI.get({ url: `/guilds/${guild.id}/webhooks` })
            .then(({ body }) => { if (live) setHooks((body as Hook[]).filter(hook => hook.token)); })
            .catch(() => { /* needs Manage Webhooks, which only the embed route wants */ });

        return () => { live = false; };
    }, [guild.id]);

    const memberCount = GuildMemberCountStore.getMemberCount(guild.id) ?? 0;
    const channel = channels.find(c => c.id === channelId);
    const chosen = roles.filter(role => picked.includes(role.id));

    const here = hooks.filter(hook => hook.channel_id === channelId);
    const hook = here.find(h => h.id === hookId) ?? here[0];

    const mentions = [everyone ? "@everyone" : "", ...chosen.map(role => `<@&${role.id}>`)].filter(Boolean).join(" ");
    const reach = everyone ? memberCount : chosen.reduce((sum, role) => sum + (counts[role.id] ?? 0), 0);

    const values = {
        server: guild.name,
        channel: channel ? `#${channel.name}` : "",
        roles: mentions,
        count: String(reach)
    };

    const filledTitle = fill(title, values);
    const filledBody = fill(body, values);

    // as me there is no embed to put a title in, so it becomes a markdown heading
    const asText = [
        mentions,
        filledTitle && `## ${filledTitle}`,
        filledBody
    ].filter(Boolean).join("\n");

    const canMentionAnything = channel != null && PermissionStore.can(PermissionsBits.MENTION_EVERYONE, channel);
    const silent = chosen.filter(role => !role.mentionable && !canMentionAnything);
    const bytes = files.reduce((sum, file) => sum + file.size, 0);

    const allowed = { parse: everyone ? ["everyone"] : [], roles: picked, users: [] };

    async function send() {
        setBusy(true);
        try {
            const attachments = files.map((file, i) => ({ name: `files[${i}]`, file, filename: file.name }));

            const payload = asWebhook
                ? {
                    content: mentions || undefined,
                    embeds: [{
                        title: filledTitle || undefined,
                        description: filledBody || undefined,
                        color: parseInt(colour.slice(1), 16)
                    }],
                    allowed_mentions: allowed
                }
                : { content: asText, allowed_mentions: allowed };

            const url = asWebhook && hook
                ? `/webhooks/${hook.id}/${hook.token}?wait=true`
                : `/channels/${channelId}/messages`;

            // superagent takes files through `attachments` and the json alongside them
            // as a payload_json field, which is the shape Discord's own client uses
            const { body: message } = await RestAPI.post(attachments.length
                ? { url, attachments, fields: [{ name: "payload_json", value: JSON.stringify(payload) }] } as any
                : { url, body: payload });

            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: `Posted ${filledTitle ? `"${filledTitle}" ` : ""}in #${channel?.name}${reach ? `, pinging ${plural(reach, "person")}` : ""}`,
                targets: message?.id
                    ? [{ kind: "message", channelId, name: channel?.name ?? channelId, messageId: message.id }]
                    : []
            });

            Toasts.show({ id: Toasts.genId(), type: Toasts.Type.SUCCESS, message: "Sent" });
            modalProps.onClose();
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            setBusy(false);
        }
    }

    async function makeHook() {
        setBusy(true);
        try {
            const { body: made } = await RestAPI.post({
                url: `/channels/${channelId}/webhooks`,
                body: { name: "Announcements" }
            });
            setHooks(prev => [...prev, made]);
            setHookId(made.id);
        } catch (error) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: `Discord refused that: ${String((error as any)?.body?.message ?? error)}`
            });
        } finally {
            setBusy(false);
        }
    }

    const blocked = asWebhook && !hook;

    return (
        <Modal {...modalProps} size="md" title={<Forms.FormTitle tag="h5">Post to {guild.name}</Forms.FormTitle>}>
            <div className={cl("safety")}>
                <div className={cl("cast-row")}>
                    <Text variant="text-sm/normal">Channel</Text>
                    <Select
                        options={channels.map(c => ({ label: `#${c.name}`, value: c.id }))}
                        select={setChannelId}
                        isSelected={value => value === channelId}
                        serialize={String}
                    />
                </div>

                {templates.length > 0 && (
                    <div className={cl("cast-row")}>
                        <Text variant="text-sm/normal">Template</Text>
                        <Select
                            options={templates.map(t => ({ label: t.name, value: t.id }))}
                            select={(id: string) => setBody(templates.find(t => t.id === id)?.body ?? body)}
                            isSelected={() => false}
                            serialize={String}
                        />
                        <Button
                            size={Button.Sizes.SMALL}
                            look={Button.Looks.LINK}
                            onClick={() => {
                                const match = templates.find(t => t.body === body);
                                if (match) deleteTemplate(match.id).then(setTemplates);
                            }}
                        >
                            Delete
                        </Button>
                    </div>
                )}

                <div className={cl("cast-row")}>
                    <TextInput value={title} placeholder="Title, optional" onChange={setTitle} />
                </div>

                <textarea
                    className={cl("cast-body")}
                    value={body}
                    disabled={busy}
                    placeholder="What do you want to say? {server} {channel} {roles} {count} get filled in."
                    onChange={e => setBody(e.currentTarget.value)}
                />

                <div className={cl("cast-row")}>
                    <TextInput
                        value={name}
                        placeholder="Save this as a template called..."
                        onChange={setName}
                    />
                    <Button
                        size={Button.Sizes.SMALL}
                        look={Button.Looks.LINK}
                        disabled={!name.trim() || !body.trim()}
                        onClick={() => saveTemplate(name.trim(), body).then(saved => { setTemplates(saved); setName(""); })}
                    >
                        Save
                    </Button>
                </div>

                <div className={cl("cast-row")}>
                    <label className={cl("cast-file")}>
                        Add files
                        <input
                            type="file"
                            multiple
                            hidden
                            onChange={e => {
                                setFiles(prev => [...prev, ...Array.from(e.currentTarget.files ?? [])]);
                                e.currentTarget.value = "";
                            }}
                        />
                    </label>
                    <Text variant="text-sm/normal">
                        {files.length
                            ? `${plural(files.length, "file")}, ${(bytes / MB).toFixed(1)}MB`
                            : "nothing attached"}
                    </Text>
                </div>

                {files.map((file, i) => (
                    <div key={`${file.name}-${i}`} className={cl("cast-row")}>
                        <Text variant="text-sm/normal">{file.name}</Text>
                        <Button
                            size={Button.Sizes.SMALL}
                            look={Button.Looks.LINK}
                            onClick={() => setFiles(prev => prev.filter((_, at) => at !== i))}
                        >
                            Remove
                        </Button>
                    </div>
                ))}

                <FormSwitch
                    hideBorder
                    title="Send it as a real embed"
                    description="Goes through a webhook, so it gets a title bar and a colour but posts under the webhook's name rather than yours"
                    value={asWebhook}
                    disabled={busy}
                    onChange={setAsWebhook}
                />

                {asWebhook && (
                    <div className={cl("cast-row")}>
                        {here.length
                            ? (
                                <Select
                                    options={here.map(h => ({ label: h.name, value: h.id }))}
                                    select={setHookId}
                                    isSelected={value => value === hook?.id}
                                    serialize={String}
                                />
                            )
                            : <Text variant="text-sm/normal">No webhook in this channel yet</Text>}

                        <input
                            type="color"
                            className={cl("cast-colour")}
                            value={colour}
                            onChange={e => setColour(e.currentTarget.value)}
                        />

                        {!here.length && (
                            <Button size={Button.Sizes.SMALL} look={Button.Looks.LINK} disabled={busy} onClick={makeHook}>
                                Make one
                            </Button>
                        )}
                    </div>
                )}

                <FormSwitch
                    hideBorder
                    title="Send automatic safety alerts here"
                    description="When a server picks up a new critical problem while you are online, post it here as well as telling you"
                    value={alertsHere}
                    disabled={busy}
                    onChange={on => { setAlertsHere(on); void setAlertChannel(guild.id, on ? channelId : null); }}
                />

                <ScrollerThin className={cl("cast-roles")} orientation="vertical">
                    <FormSwitch
                        hideBorder
                        title="@everyone"
                        description={`Everyone here, ${plural(memberCount, "person")}`}
                        value={everyone}
                        disabled={busy}
                        onChange={setEveryone}
                    />
                    {roles.map((role: Role) => (
                        <FormSwitch
                            key={role.id}
                            hideBorder
                            title={role.name}
                            description={counts[role.id] != null ? plural(counts[role.id], "person") : undefined}
                            value={picked.includes(role.id)}
                            disabled={busy || everyone}
                            onChange={on => setPicked(prev => on ? [...prev, role.id] : prev.filter(id => id !== role.id))}
                        />
                    ))}
                </ScrollerThin>

                <div className={cl("safety-summary")}>
                    <Text variant="text-sm/semibold">Preview</Text>
                    {asWebhook
                        ? (
                            <div className={cl("cast-embed")} style={{ borderLeftColor: colour }}>
                                {filledTitle && <div className={cl("cast-embed-title")}>{filledTitle}</div>}
                                <div className={cl("cast-preview")}>{filledBody || "Nothing yet."}</div>
                            </div>
                        )
                        : <div className={cl("cast-preview")}>{asText || "Nothing yet."}</div>}

                    {silent.length > 0 && (
                        <Text variant="text-sm/normal">
                            {list(silent.map(role => role.name))} {silent.length === 1 ? "is" : "are"} not mentionable and you cannot mention everyone here, so {silent.length === 1 ? "that ping" : "those pings"} will show as text but notify nobody.
                        </Text>
                    )}
                    {blocked && (
                        <Text variant="text-sm/normal">
                            An embed needs a webhook in that channel and there is not one you can use. Make one above, or turn the embed off and it posts as you.
                        </Text>
                    )}
                </div>

                <div className={cl("power-apply")}>
                    <Text variant="text-sm/normal">
                        {reach ? `Pings ${plural(reach, "person")}.` : "Pings nobody."}
                    </Text>
                    <Button
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.BRAND}
                        disabled={busy || blocked || !channelId || (!filledBody.trim() && !filledTitle.trim() && !files.length)}
                        onClick={() => Alerts.show({
                            title: `Post to #${channel?.name}?`,
                            body: (
                                <div>
                                    {filledTitle && <p><strong>{filledTitle}</strong></p>}
                                    <p>{filledBody}</p>
                                    {files.length > 0 && <p>With {list(files.map(f => f.name))}.</p>}
                                    <p><strong>{reach ? `This pings ${plural(reach, "person")}.` : "This pings nobody."}</strong></p>
                                    {asWebhook && <p>It will post as {hook?.name}, not as you.</p>}
                                </div>
                            ),
                            confirmText: "Post it",
                            cancelText: "Cancel",
                            onConfirm: send
                        })}
                    >
                        Post
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

export function openBroadcastModal(guild: Guild, initial?: string) {
    openModal(props => <Broadcast guild={guild} initial={initial} modalProps={props} />);
}
