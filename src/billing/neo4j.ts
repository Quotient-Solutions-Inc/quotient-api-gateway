import neo4j, { type Driver, type Session } from "neo4j-driver";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    const uri = process.env.NEO4J_URI;
    const username = process.env.NEO4J_USER;
    const password = process.env.NEO4J_PASS;

    if (!uri || !username || !password) {
      throw new Error("Missing NEO4J_URI, NEO4J_USER, or NEO4J_PASS for durable billing.");
    }

    driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
      maxConnectionPoolSize: 20,
      connectionAcquisitionTimeout: 30000
    });
  }
  return driver;
}

function toNative(val: unknown): unknown {
  if (neo4j.isInt(val)) {
    return neo4j.integer.toNumber(val);
  }
  if (Array.isArray(val)) {
    return val.map(toNative);
  }
  if (val !== null && typeof val === "object" && !(val instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = toNative(v);
    }
    return out;
  }
  return val;
}

export async function executeBillingQuery<T = Record<string, unknown>>(
  query: string,
  params: Record<string, unknown> = {}
): Promise<T[]> {
  const d = getDriver();
  const session: Session = d.session({ database: "neo4j" });
  try {
    const coerced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      coerced[key] =
        typeof value === "number" && Number.isInteger(value)
          ? neo4j.int(value)
          : value;
    }
    const result = await session.run(query, coerced);
    return result.records.map((record) => toNative(record.toObject()) as T);
  } finally {
    await session.close();
  }
}
