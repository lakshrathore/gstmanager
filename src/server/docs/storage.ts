import 'server-only';
import mongoose, { Types } from 'mongoose';
import { db } from '../db';

/** Original client files in GridFS (bucket "clientfiles"), so every extracted record can open its source. */

async function bucket() {
  const m = await db();
  return new mongoose.mongo.GridFSBucket(m.connection.db!, { bucketName: 'clientfiles' });
}

export async function putFile(bytes: Buffer, fileName: string, contentType: string, meta: Record<string, unknown>): Promise<Types.ObjectId> {
  const b = await bucket();
  const id = new Types.ObjectId();
  await new Promise<void>((resolve, reject) => {
    const up = b.openUploadStreamWithId(id, fileName, { metadata: { ...meta, contentType } });
    up.once('finish', () => resolve());
    up.once('error', reject);
    up.end(bytes);
  });
  return id;
}

export async function getFile(id: Types.ObjectId): Promise<Buffer> {
  const b = await bucket();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    b.openDownloadStream(id).on('data', (c: Buffer) => chunks.push(c)).once('end', () => resolve()).once('error', reject);
  });
  return Buffer.concat(chunks);
}

export async function deleteFile(id: Types.ObjectId) {
  const b = await bucket();
  await b.delete(id).catch(() => undefined);
}
