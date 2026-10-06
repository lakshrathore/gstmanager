import Ajv, { type ErrorObject } from 'ajv';

/**
 * Structural JSON Schema for the generated GSTR-1 file.
 * GSTN does not publish an official JSON Schema; this one is maintained internally from the
 * offline-tool output format and enforced before every download/upload. Version it alongside
 * FORMAT_PROFILES when the format changes.
 */
const money = { type: 'number', minimum: 0 };
const signedMoney = { type: 'number' };
const date = { type: 'string', pattern: '^\\d{2}-\\d{2}-\\d{4}$' };
const pos = { type: 'string', pattern: '^\\d{2}$' };
const gstin = { type: 'string', pattern: '^[0-9]{2}[0-9A-Z]{13}$' };
const docNo = { type: 'string', pattern: '^[A-Za-z0-9/-]{1,16}$' };
const tax = { iamt: money, camt: money, samt: money, csamt: money };
const itm = {
  type: 'object', required: ['num', 'itm_det'],
  properties: {
    num: { type: 'integer' },
    itm_det: { type: 'object', required: ['txval', 'rt'], properties: { txval: signedMoney, rt: { type: 'number' }, ...tax }, additionalProperties: false },
  },
  additionalProperties: false,
};
const itms = { type: 'array', minItems: 1, items: itm };
const diff = { diff_percent: { type: 'number', enum: [0.65] } };
const hsnRow = {
  type: 'object', required: ['num', 'hsn_sc', 'uqc', 'qty', 'rt', 'txval'],
  properties: {
    num: { type: 'integer' }, hsn_sc: { type: 'string', pattern: '^\\d{4,8}$' }, desc: { type: 'string', maxLength: 30 },
    /** Written by the GST offline tool (the user's own description). */
    user_desc: { type: 'string' },
    uqc: { type: 'string' }, qty: { type: 'number' }, rt: { type: 'number' }, txval: signedMoney,
    iamt: signedMoney, camt: signedMoney, samt: signedMoney, csamt: signedMoney,
  },
  additionalProperties: false,
};
const advance = {
  type: 'array',
  items: {
    type: 'object', required: ['pos', 'sply_ty', 'itms'],
    properties: {
      pos, sply_ty: { enum: ['INTER', 'INTRA'] }, ...diff,
      itms: { type: 'array', minItems: 1, items: { type: 'object', required: ['rt', 'ad_amt'], properties: { rt: { type: 'number' }, ad_amt: money, ...tax }, additionalProperties: false } },
    },
    additionalProperties: false,
  },
};

/* Amendment sections (GSTN "Save GSTR1" v4.1: 9A b2ba/b2cla/expa, 9C cdnra/cdnura, 10 b2csa, 11 ata/txpda). */
const omon = { type: 'string', pattern: '^(0[1-9]|1[0-2])\\d{4}$' };
const flatItms = (keys: Record<string, unknown>, required: string[]) => ({
  type: 'array', minItems: 1, items: { type: 'object', required, properties: keys, additionalProperties: false },
});
const amendedAdvance = {
  type: 'array',
  items: {
    type: 'object', required: ['omon', 'pos', 'sply_ty', 'itms'],
    properties: { omon, pos, sply_ty: { enum: ['INTER', 'INTRA'] }, ...diff, itms: flatItms({ rt: { type: 'number' }, ad_amt: money, ...tax }, ['rt', 'ad_amt']) },
    additionalProperties: false,
  },
};
const AMENDMENT_SCHEMA = {
  b2ba: {
    type: 'array',
    items: {
      type: 'object', required: ['ctin', 'inv'],
      properties: {
        ctin: gstin,
        inv: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', required: ['oinum', 'oidt', 'inum', 'idt', 'val', 'pos', 'rchrg', 'inv_typ', 'itms'],
            properties: { oinum: docNo, oidt: date, inum: docNo, idt: date, val: money, pos, rchrg: { enum: ['Y', 'N'] }, etin: gstin, inv_typ: { enum: ['R', 'SEWP', 'SEWOP', 'DE', 'CBW'] }, ...diff, itms },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  b2cla: {
    type: 'array',
    items: {
      type: 'object', required: ['pos', 'inv'],
      properties: {
        pos,
        inv: { type: 'array', minItems: 1, items: { type: 'object', required: ['oinum', 'oidt', 'inum', 'idt', 'val', 'itms'], properties: { oinum: docNo, oidt: date, inum: docNo, idt: date, val: money, etin: gstin, ...diff, itms }, additionalProperties: false } },
      },
      additionalProperties: false,
    },
  },
  expa: {
    type: 'array',
    items: {
      type: 'object', required: ['exp_typ', 'inv'],
      properties: {
        exp_typ: { enum: ['WPAY', 'WOPAY'] },
        inv: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', required: ['oinum', 'oidt', 'inum', 'idt', 'val', 'itms'],
            properties: { oinum: docNo, oidt: date, inum: docNo, idt: date, val: money, sbpcode: { type: 'string' }, sbnum: { type: 'string' }, sbdt: date, itms: flatItms({ txval: money, rt: { type: 'number' }, iamt: money, csamt: money }, ['txval', 'rt']) },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  cdnra: {
    type: 'array',
    items: {
      type: 'object', required: ['ctin', 'nt'],
      properties: {
        ctin: gstin,
        nt: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', required: ['ont_num', 'ont_dt', 'ntty', 'nt_num', 'nt_dt', 'val', 'pos', 'rchrg', 'inv_typ', 'itms'],
            properties: { ont_num: docNo, ont_dt: date, ntty: { enum: ['C', 'D'] }, nt_num: docNo, nt_dt: date, val: money, pos, rchrg: { enum: ['Y', 'N'] }, inv_typ: { enum: ['R', 'SEWP', 'SEWOP', 'DE', 'CBW'] }, ...diff, itms },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  cdnura: {
    type: 'array',
    items: {
      type: 'object', required: ['typ', 'ont_num', 'ont_dt', 'ntty', 'nt_num', 'nt_dt', 'val', 'itms'],
      properties: { typ: { enum: ['B2CL', 'EXPWP', 'EXPWOP'] }, ont_num: docNo, ont_dt: date, ntty: { enum: ['C', 'D'] }, nt_num: docNo, nt_dt: date, val: money, pos, ...diff, itms },
      additionalProperties: false,
    },
  },
  b2csa: {
    type: 'array',
    items: {
      type: 'object', required: ['omon', 'pos', 'sply_ty', 'typ', 'itms'],
      properties: {
        omon, pos, sply_ty: { enum: ['INTER', 'INTRA'] }, typ: { enum: ['OE', 'E'] }, etin: gstin, ...diff,
        itms: flatItms({ rt: { type: 'number' }, txval: signedMoney, ...tax }, ['rt', 'txval']),
      },
      additionalProperties: false,
    },
  },
  ata: amendedAdvance,
  txpda: amendedAdvance,
};

export const GSTR1_SCHEMA = {
  $id: 'gstr1-upload',
  type: 'object',
  required: ['gstin', 'fp', 'version', 'hash'],
  properties: {
    gstin, fp: { type: 'string', pattern: '^(0[1-9]|1[0-2])\\d{4}$' }, version: { type: 'string' }, hash: { type: 'string' },
    /** Gross turnover fields the GST offline tool still writes. */
    gt: { type: 'number' }, cur_gt: { type: 'number' },
    b2b: {
      type: 'array',
      items: {
        type: 'object', required: ['ctin', 'inv'],
        properties: {
          ctin: gstin,
          inv: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['inum', 'idt', 'val', 'pos', 'rchrg', 'inv_typ', 'itms'],
              properties: { inum: docNo, idt: date, val: money, pos, rchrg: { enum: ['Y', 'N'] }, inv_typ: { enum: ['R', 'SEWP', 'SEWOP', 'DE', 'CBW'] }, etin: gstin, ...diff, itms },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    b2cl: {
      type: 'array',
      items: {
        type: 'object', required: ['pos', 'inv'],
        properties: {
          pos,
          inv: { type: 'array', minItems: 1, items: { type: 'object', required: ['inum', 'idt', 'val', 'itms'], properties: { inum: docNo, idt: date, val: money, etin: gstin, ...diff, itms }, additionalProperties: false } },
        },
        additionalProperties: false,
      },
    },
    b2cs: {
      type: 'array',
      items: {
        type: 'object', required: ['sply_ty', 'pos', 'typ', 'rt', 'txval'],
        properties: { sply_ty: { enum: ['INTER', 'INTRA'] }, pos, typ: { enum: ['OE', 'E'] }, etin: gstin, ...diff, rt: { type: 'number' }, txval: signedMoney, ...tax },
        additionalProperties: false,
      },
    },
    exp: {
      type: 'array',
      items: {
        type: 'object', required: ['exp_typ', 'inv'],
        properties: {
          exp_typ: { enum: ['WPAY', 'WOPAY'] },
          inv: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['inum', 'idt', 'val', 'itms'],
              properties: {
                inum: docNo, idt: date, val: money, sbpcode: { type: 'string' }, sbnum: { type: 'string' }, sbdt: date,
                itms: { type: 'array', minItems: 1, items: { type: 'object', required: ['txval', 'rt'], properties: { txval: money, rt: { type: 'number' }, iamt: money, csamt: money }, additionalProperties: false } },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    cdnr: {
      type: 'array',
      items: {
        type: 'object', required: ['ctin', 'nt'],
        properties: {
          ctin: gstin,
          nt: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', required: ['ntty', 'nt_num', 'nt_dt', 'val', 'pos', 'rchrg', 'inv_typ', 'itms'],
              properties: { ntty: { enum: ['C', 'D'] }, nt_num: docNo, nt_dt: date, val: money, pos, rchrg: { enum: ['Y', 'N'] }, inv_typ: { enum: ['R', 'SEWP', 'SEWOP', 'DE', 'CBW'] }, ...diff, itms },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    cdnur: {
      type: 'array',
      items: {
        type: 'object', required: ['typ', 'ntty', 'nt_num', 'nt_dt', 'val', 'itms'],
        properties: { typ: { enum: ['B2CL', 'EXPWP', 'EXPWOP'] }, ntty: { enum: ['C', 'D'] }, nt_num: docNo, nt_dt: date, val: money, pos, ...diff, itms },
        additionalProperties: false,
      },
    },
    at: advance,
    txpd: advance,
    ...AMENDMENT_SCHEMA,
    nil: {
      type: 'object', required: ['inv'],
      properties: {
        inv: { type: 'array', items: { type: 'object', required: ['sply_ty'], properties: { sply_ty: { enum: ['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'] }, expt_amt: money, nil_amt: money, ngsup_amt: money }, additionalProperties: false } },
      },
      additionalProperties: false,
    },
    hsn: {
      type: 'object',
      properties: { data: { type: 'array', items: hsnRow }, hsn_b2b: { type: 'array', items: hsnRow }, hsn_b2c: { type: 'array', items: hsnRow } },
      additionalProperties: false,
    },
    doc_issue: {
      type: 'object', required: ['doc_det'],
      properties: {
        doc_det: {
          type: 'array',
          items: {
            type: 'object', required: ['doc_num', 'docs'],
            properties: {
              doc_num: { type: 'integer', minimum: 1, maximum: 12 }, doc_typ: { type: 'string' },
              docs: { type: 'array', items: { type: 'object', required: ['num', 'from', 'to', 'totnum', 'cancel', 'net_issue'], properties: { num: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' }, totnum: { type: 'integer', minimum: 0 }, cancel: { type: 'integer', minimum: 0 }, net_issue: { type: 'integer', minimum: 0 } }, additionalProperties: false } },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(GSTR1_SCHEMA);

export interface SchemaError { path: string; message: string; keyword: string; property?: string }

export function validateGstr1Json(json: unknown): { ok: boolean; errors: SchemaError[] } {
  const ok = validateFn(json) as boolean;
  return {
    ok,
    errors: (validateFn.errors ?? []).map((e: ErrorObject) => {
      const p = e.params as { allowedValues?: unknown[]; additionalProperty?: string };
      return {
        path: e.instancePath || '/',
        message: `${e.message}${p?.allowedValues ? `: ${p.allowedValues.join(', ')}` : ''}${p?.additionalProperty ? ` ("${p.additionalProperty}")` : ''}`,
        keyword: e.keyword,
        ...(p?.additionalProperty ? { property: p.additionalProperty } : {}),
      };
    }),
  };
}
