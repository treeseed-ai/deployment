/** Root-private local bootstrap; every network client must verify TLS and use SCRAM. */
export const POSTGRES_HBA = `local all all trust
hostnossl all all 0.0.0.0/0 reject
hostnossl all all ::/0 reject
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl all all ::/0 scram-sha-256
`;
