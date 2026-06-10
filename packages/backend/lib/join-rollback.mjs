export function createJoinRollbackSnapshot({
    currentList,
    baseKey,
    encryptionKey,
    ownerAuthorityKeyPair,
    epochKey,
    epochEncryptionKeyPair,
}) {
    return {
        previousList: Array.isArray(currentList) ? [...currentList] : [],
        previousBaseKey: cloneBuffer(baseKey),
        previousEncryptionKey: cloneBuffer(encryptionKey),
        previousOwnerAuthorityKeyPair: cloneOwnerAuthorityKeyPair(ownerAuthorityKeyPair),
        previousEpochKey: cloneBuffer(epochKey),
        previousEpochEncryptionKeyPair: cloneKeyPair(epochEncryptionKeyPair),
    }
}

export async function restoreJoinRollbackSnapshot(snapshot, {
    rpc,
    syncListCommand,
    setEncryptionKey,
    setOwnerAuthorityKeyPair,
    saveOwnerAuthorityKey,
    deleteOwnerAuthorityKey,
    setEpochKey,
    saveEpochKey,
    deleteEpochKey,
    setEpochEncryptionKeyPair,
    saveEpochEncryptionKey,
    deleteEpochEncryptionKey,
    initAutobase,
}) {
    if (!snapshot) return false

    if (rpc && snapshot.previousList.length > 0) {
        const syncReq = rpc.request(syncListCommand)
        syncReq.send(JSON.stringify(snapshot.previousList))
    }

    if (!snapshot.previousBaseKey) return false

    setEncryptionKey(snapshot.previousEncryptionKey)
    if (setOwnerAuthorityKeyPair) {
        setOwnerAuthorityKeyPair(snapshot.previousOwnerAuthorityKeyPair)
    }
    if (snapshot.previousOwnerAuthorityKeyPair?.secretKey && saveOwnerAuthorityKey) {
        await saveOwnerAuthorityKey(snapshot.previousOwnerAuthorityKeyPair.secretKey)
    } else if (!snapshot.previousOwnerAuthorityKeyPair && deleteOwnerAuthorityKey) {
        await deleteOwnerAuthorityKey()
    }
    if (setEpochKey) setEpochKey(snapshot.previousEpochKey)
    if (snapshot.previousEpochKey && saveEpochKey) {
        await saveEpochKey(snapshot.previousEpochKey)
    } else if (!snapshot.previousEpochKey && deleteEpochKey) {
        await deleteEpochKey()
    }
    if (setEpochEncryptionKeyPair) {
        setEpochEncryptionKeyPair(snapshot.previousEpochEncryptionKeyPair)
    }
    if (snapshot.previousEpochEncryptionKeyPair?.secretKey && saveEpochEncryptionKey) {
        await saveEpochEncryptionKey(snapshot.previousEpochEncryptionKeyPair.secretKey)
    } else if (!snapshot.previousEpochEncryptionKeyPair && deleteEpochEncryptionKey) {
        await deleteEpochEncryptionKey()
    }
    await initAutobase(snapshot.previousBaseKey)
    return true
}

function cloneBuffer(value) {
    if (!value) return null
    return Buffer.from(value)
}

function cloneOwnerAuthorityKeyPair(keyPair) {
    return cloneKeyPair(keyPair)
}

function cloneKeyPair(keyPair) {
    if (!keyPair) return null
    return {
        publicKey: cloneBuffer(keyPair.publicKey),
        secretKey: cloneBuffer(keyPair.secretKey),
    }
}
