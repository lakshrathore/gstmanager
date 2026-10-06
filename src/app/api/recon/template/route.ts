import { api } from '@/server/http';
import { booksTemplate } from '@/server/recon';

/** Purchase register template (Excel) for the books upload. */
export const GET = api('return:view', async () =>
  new Response(new Uint8Array(await booksTemplate()), {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="Purchase_register_template.xlsx"' },
  }));
