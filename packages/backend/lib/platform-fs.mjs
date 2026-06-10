let backendFs = null

export function setBackendFs(fs) {
    backendFs = fs
}

export function getBackendFs() {
    if (!backendFs) {
        throw new Error('Backend filesystem adapter has not been configured')
    }
    return backendFs
}
