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

export function sendableChannels(guild: Guild): Channel[] {
    return guildChannels(guild.id)
        .filter(channel => TEXTY.has(channel.type) && PermissionStore.can(PermissionsBits.SEND_MESSAGES, channel));
}

function Broadcast({ guild, initial, modalProps }: { guild: Guild; initial?: string; modalProps: RenderModalProps; }) {
    const channels = sendableChannels(guild);
    const roles = GuildRoleStore.getSortedRoles(guild.id).filter(role => role.id !== guild.id);

    const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
    const [picked, setPicked] = useState<string[]>([]);
    const [everyone, setEveryone] = useState(false);
    const [body, setBody] = useState(initial ?? "");
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

        return () => { live = false; };
    }, [guild.id]);

    const memberCount = GuildMemberCountStore.getMemberCount(guild.id) ?? 0;
    const channel = channels.find(c => c.id === channelId);
    const chosen = roles.filter(role => picked.includes(role.id));

    const mentions = [everyone ? "@everyone" : "", ...chosen.map(role => `<@&${role.id}>`)].filter(Boolean).join(" ");
    const values = {
        server: guild.name,
        channel: channel ? `#${channel.name}` : "",
        roles: mentions,
        count: String(everyone ? memberCount : chosen.reduce((sum, role) => sum + (counts[role.id] ?? 0), 0))
    };

    const filled = fill(body, values);
    const content = body.includes("{roles}") || !mentions ? filled : `${mentions}\n${filled}`;

    const reach = everyone
        ? memberCount
        : chosen.reduce((sum, role) => sum + (counts[role.id] ?? 0), 0);

    // a role that is not mentionable only pings if you may mention everyone here
    const canMentionAnything = channel != null && PermissionStore.can(PermissionsBits.MENTION_EVERYONE, channel);
    const silent = chosen.filter(role => !role.mentionable && !canMentionAnything);

    async function send() {
        setBusy(true);
        try {
            const { body: message } = await RestAPI.post({
                url: `/channels/${channelId}/messages`,
                body: {
                    content,
                    // only what was ticked can ping, whatever the text happens to contain
                    allowed_mentions: {
                        parse: everyone ? ["everyone"] : [],
                        roles: picked,
                        users: []
                    }
                }
            });

            await record({
                guildId: guild.id,
                guildName: guild.name,
                what: `Posted in #${channel?.name}${reach ? `, pinging ${plural(reach, "person")}` : ""}`,
                targets: [{ kind: "message", channelId, name: channel?.name ?? channelId, messageId: message.id }]
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
                    <div className={cl("cast-preview")}>{content || "Nothing yet."}</div>
                    {silent.length > 0 && (
                        <Text variant="text-sm/normal">
                            {list(silent.map(role => role.name))} {silent.length === 1 ? "is" : "are"} not mentionable and you cannot mention everyone here, so {silent.length === 1 ? "that ping" : "those pings"} will show as text but notify nobody.
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
                        disabled={busy || !content.trim() || !channelId}
                        onClick={() => Alerts.show({
                            title: `Post to #${channel?.name}?`,
                            body: (
                                <div>
                                    <p>{content}</p>
                                    <p><strong>{reach ? `This pings ${plural(reach, "person")}.` : "This pings nobody."}</strong></p>
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
