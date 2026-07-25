export declare const SHARED_CREDS_LIST_TYPE: 'sharedcreds'
export declare const SHARED_JOINREQ_LIST_TYPE: 'sharedjoinreq'

export declare const DURABLE_META_LIST_TYPES: ReadonlySet<string>
export declare const VOLATILE_META_LIST_TYPES: ReadonlySet<string>
export declare const META_LIST_TYPES: ReadonlySet<string>

/** True for any reserved-bucket record: not a row the user created. */
export declare function isMetaItem(item: unknown): boolean

/** True for a real user row (the complement of isMetaItem for well-formed items). */
export declare function isUserItem(item: unknown): boolean

/** True for reserved records that must not be written into a backup/export. */
export declare function isVolatileMetaItem(item: unknown): boolean

/** What an export/backup should carry: user rows plus durable meta. */
export declare function isExportableItem(item: unknown): boolean
