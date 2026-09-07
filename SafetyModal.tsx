/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Guild, RenderModalProps } from "@vencord/discord-types";
import { Forms, IconUtils, Modal, openModal } from "@webpack/common";

import { SafetyTab } from "./SafetyTab";

const cl = classNameFactory("vc-ss-");

function SafetyModal({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    const icon = guild.icon && IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: false, size: 128 });

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={
                <div className={cl("head")}>
                    {icon && <img className={cl("head-icon")} src={icon} alt="" />}
                    <Forms.FormTitle tag="h5" className={cl("head-name")}>{guild.name}</Forms.FormTitle>
                </div>
            }
        >
            <SafetyTab guild={guild} onClose={modalProps.onClose} />
        </Modal>
    );
}

export function openGuildSafetyModal(guild: Guild) {
    openModal(props => <SafetyModal guild={guild} modalProps={props} />);
}
