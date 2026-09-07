/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

const KEY = "serverInfo-templates";

export interface Template {
    id: string;
    name: string;
    body: string;
}

export const readTemplates = async () => await DataStore.get<Template[]>(KEY) ?? [];

export async function saveTemplate(name: string, body: string) {
    const templates = await readTemplates();
    const existing = templates.find(template => template.name === name);

    if (existing) existing.body = body;
    else templates.push({ id: `${Date.now().toString(36)}`, name, body });

    await DataStore.set(KEY, templates);
    return templates;
}

export async function deleteTemplate(id: string) {
    const templates = (await readTemplates()).filter(template => template.id !== id);
    await DataStore.set(KEY, templates);
    return templates;
}

/** the preview and the sent message run through the same function, so what you see
 *  is what goes out */
export function fill(body: string, values: Record<string, string>) {
    return body.replace(/\{(\w+)\}/g, (whole, key) => values[key] ?? whole);
}
