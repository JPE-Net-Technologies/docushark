/**
 * Database Icons
 *
 * Icons sourced from simple-icons (simpleicons.org) — CC0 License.
 */

import type { BuiltinIcon } from './index';
import {
  siPostgresql, siMysql, siMariadb, siMongodb, siRedis, siElasticsearch,
  siSqlite, siNeo4j, siCouchbase, siInfluxdb, siSupabase, siFirebase,
  siPlanetscale, siPrisma, siDrizzle, siTurso, siSinglestore, siClickhouse,
  siApachecouchdb,
} from 'simple-icons';

function fromSi(icon: { title: string; path: string; slug: string }, nameOverride?: string): BuiltinIcon {
  return {
    name: nameOverride ?? icon.title,
    category: 'databases',
    svg: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${icon.path}"/></svg>`,
  };
}

const databaseIcons: BuiltinIcon[] = [
  fromSi(siPostgresql),
  fromSi(siMysql),
  fromSi(siMariadb),
  fromSi(siMongodb),
  fromSi(siRedis),
  fromSi(siElasticsearch),
  fromSi(siSqlite),
  fromSi(siNeo4j),
  fromSi(siCouchbase),
  fromSi(siInfluxdb),
  fromSi(siSupabase),
  fromSi(siFirebase),
  fromSi(siPlanetscale),
  fromSi(siPrisma),
  fromSi(siDrizzle),
  fromSi(siTurso),
  fromSi(siSinglestore),
  fromSi(siClickhouse),
  fromSi(siApachecouchdb, 'CouchDB'),
];

export default databaseIcons;
