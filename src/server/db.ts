import 'server-only';
import mongoose from 'mongoose';

const g = globalThis as unknown as { __mongo?: Promise<typeof mongoose> };

export function db(): Promise<typeof mongoose> {
  if (!g.__mongo) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    mongoose.set('strictQuery', true);
    g.__mongo = mongoose.connect(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 8000 }).catch((e) => {
      g.__mongo = undefined;
      throw e;
    });
  }
  return g.__mongo;
}
