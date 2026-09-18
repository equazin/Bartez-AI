import { Client } from '@notionhq/client';

const token = process.env.NOTION_TOKEN ?? '';
const configurado = Boolean(token);

export const notion = new Client({ auth: token || 'stub' });

export function notionConfigurado(): boolean {
    return configurado;
}
