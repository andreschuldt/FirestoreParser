import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import * as admin from 'firebase-admin';

// Initialize Firestore
const serviceAccount = require('./serviceAccountKey.json'); // <-- Put your Firebase service account here
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Firestore collection names (change these for testing)
const DEVICES_COLLECTION = 'DevicesTest';                // Change to 'Devices' for production
const USERS_COLLECTION = 'UsersTest';                    // Change to 'Users' for production
const INTERACTIONS_COLLECTION = 'InteractionsTest';      // Change to 'interactions' for production
const DEVICES_UPDATES_COLLECTION = 'DevicesUpdatesTest'; // Change to 'DevicesUpdates' for production

// Helper: Map CSV row to Device object
function csvRowToDevice(row: Record<string, string>): any {
  return {
    deviceID: row['ID'],
    isRetired: row['Retired?']?.toLowerCase() === 'yes' || row['Retired?']?.toLowerCase() === 'true',
    attributeList: {
      invNr: row['Inventory Number'],
      deviceName: row['Model'],
      deviceType: row['Device Type'],
      publisher: row['Publisher'],
      os: row['OS'],
      osVersion: row['OS Version'],
      stickerNumber: row['Sticker-Number (iOS)'],
    },
    // currentUser and isAvailable handled below
  };
}

// Helper: Deep compare allowed attributes
function attributesChanged(a: any, b: any): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

// Helper: Get all devices snapshot
async function getAllDevicesSnapshot() {
  const snap = await db.collection(DEVICES_COLLECTION).get();
  return snap.docs.map(doc => doc.data());
}

// Helper: Get last update number from DevicesUpdates collection
async function getLastUpdateNumber(): Promise<number> {
  const snap = await db.collection(DEVICES_UPDATES_COLLECTION)
    .orderBy('updateNumber', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return 0;
  return snap.docs[0].data().updateNumber || 0;
}

// Main function
async function importDevicesFromCSV(csvPath: string) {
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Get snapshot BEFORE parsing
  const preSnapshot = await getAllDevicesSnapshot();

  let changedDevices = 0;
  let newDevices = 0;
  let attemptedInvalidChanges = 0;
  let errorCount = 0;
  let warningsSummary: string[] = [];

  for (const row of records as Record<string, string>[]) {
    const deviceID = row['ID'];
    const deviceName = row['Model'];
    const deviceType = row['Device Type'];

    if (!deviceID || !deviceName || !deviceType) {
      console.warn(`[SKIP] Row skipped: not all necessary values present to parse (deviceID, deviceName, deviceType required).`);
      continue;
    }

    const checkedOutBy = row['Checked out by?']?.trim();
    const isRetiredCSV = row['Retired?']?.toLowerCase() === 'yes' || row['Retired?']?.toLowerCase() === 'true';
    const deviceRef = db.collection(DEVICES_COLLECTION).doc(deviceID);
    const deviceSnap = await deviceRef.get();
    const deviceData = csvRowToDevice(row);

    try {
      if (!deviceSnap.exists) {
        // New device
        if (checkedOutBy) {
          deviceData.currentUser = checkedOutBy;
          deviceData.isAvailable = false;
        }
        await deviceRef.set(deviceData);
        if (checkedOutBy) {
          await createInteraction(deviceData, checkedOutBy);
          await updateUser(checkedOutBy, 1);
        }
        newDevices++;
        console.log(`[NEW] Added device: ${deviceID}${checkedOutBy ? ` (checked out by ${checkedOutBy})` : ''}`);
        continue;
      }

      // Existing device
      const existing = deviceSnap.data()!;
      let changed = false;
      let warnings: string[] = [];

      // Check forbidden changes
      if (
        row['Model'] && row['Model'] !== existing.attributeList.deviceName
      ) {
        warnings.push('Attempted change to deviceName is not allowed.');
        attemptedInvalidChanges++;
      }
      if (
        row['Device Type'] && row['Device Type'] !== existing.attributeList.deviceType
      ) {
        warnings.push('Attempted change to deviceType is not allowed.');
        attemptedInvalidChanges++;
      }
      if (
        row['ID'] && row['ID'] !== existing.deviceID
      ) {
        warnings.push('Attempted change to deviceID is not allowed.');
        attemptedInvalidChanges++;
      }
      if (
        checkedOutBy && checkedOutBy !== existing.currentUser
      ) {
        warnings.push('Attempted change to currentUser is not allowed. Please use the management app.');
        attemptedInvalidChanges++;
      }

      // Only update allowed fields
      const updatedDevice = {
        ...existing,
        attributeList: {
          ...existing.attributeList,
          publisher: row['Publisher'] ?? existing.attributeList.publisher,
          os: row['OS'] ?? existing.attributeList.os,
          osVersion: row['OS Version'] ?? existing.attributeList.osVersion,
          invNr: row['Inventory Number'] ?? existing.attributeList.invNr,
          stickerNumber: row['Sticker-Number (iOS)'] ?? existing.attributeList.stickerNumber,
          // deviceName and deviceType are NOT updated
        },
        // deviceID, deviceName, deviceType, currentUser are NOT updated
        isRetired: isRetiredCSV,
      };

      // Detect attribute changes (excluding forbidden fields)
      if (
        attributesChanged(
          {
            ...existing.attributeList,
            publisher: row['Publisher'] ?? existing.attributeList.publisher,
            os: row['OS'] ?? existing.attributeList.os,
            osVersion: row['OS Version'] ?? existing.attributeList.osVersion,
            invNr: row['Inventory Number'] ?? existing.attributeList.invNr,
            stickerNumber: row['Sticker-Number (iOS)'] ?? existing.attributeList.stickerNumber,
          },
          existing.attributeList
        ) || (existing.isRetired !== isRetiredCSV)
      ) {
        changed = true;
        await deviceRef.update(updatedDevice);
      }

      // Handle retiring a device with a currentUser
      if (isRetiredCSV && existing.currentUser) {
        // Mark device as available and remove currentUser
        await deviceRef.update({ currentUser: null, isAvailable: true });
        await handleReturn(existing.deviceID, existing.currentUser);
        warnings.push(`Device retired. User ${existing.currentUser} checked in and interaction closed.`);
        changed = true;
      }

      // Console output
      if (warnings.length > 0) {
        warningsSummary.push(`[WARN] Device ${deviceID}: ${warnings.join(' ')}`);
        console.warn(`[WARN] Device ${deviceID}: ${warnings.join(' ')}`);
      }
      if (changed) {
        changedDevices++;
        console.log(`[UPDATE] Device ${deviceID}: attributes/values changed.`);
      } else if (warnings.length === 0) {
        console.log(`[OK] Device ${deviceID}: no changes.`);
      }
    } catch (err) {
      errorCount++;
      console.error(`[ERROR] Device ${deviceID}: ${err}`);
    }
  }

  // Save snapshot to devicesUpdates collection
  const postSnapshot = await getAllDevicesSnapshot();
  const totalDevices = postSnapshot.length;

  // Get update number and document name
  const lastUpdateNumber = await getLastUpdateNumber(); // <-- gets the highest updateNumber so far
  const updateNumber = lastUpdateNumber + 1;            // <-- increments for this run
  const updateDocName = `Update${String(updateNumber).padStart(4, '0')}`; // e.g., Update0004

  await db.collection(DEVICES_UPDATES_COLLECTION).doc(updateDocName).set({
    changedDevices,
    newDevices,
    snapshot: preSnapshot.length > 0 ? preSnapshot : null,
    totalDevices,
    updateDate: admin.firestore.Timestamp.now(),
    updateNumber,
  });

  // Summary message
  console.log('\n========== PARSER SUMMARY ==========');
  console.log(`Total devices after run: ${totalDevices}`);
  console.log(`New devices added: ${newDevices}`);
  console.log(`Devices updated: ${changedDevices}`);
  console.log(`Attempted invalid changes: ${attemptedInvalidChanges}`);
  if (warningsSummary.length > 0) {
    console.log('\nWarnings:');
    warningsSummary.forEach(w => console.log(w));
  }
  if (errorCount > 0) {
    console.log(`\nErrors encountered: ${errorCount}`);
  }
  console.log(`Snapshot saved as document "${updateDocName}" in collection "${DEVICES_UPDATES_COLLECTION}".`);
  console.log('====================================\n');
}

// Helper: Create interaction
async function createInteraction(device: any, username: string) {
  const interaction = {
    deviceName: device.attributeList.deviceName,
    deviceID: device.deviceID,
    deviceInvNr: device.attributeList.invNr,
    username,
    dateOfCheckout: new Date().toISOString(),
    dateOfReturn: null,
  };
  await db.collection(INTERACTIONS_COLLECTION).add(interaction);
}

// Helper: Update user stats
async function updateUser(username: string, increment: number) {
  const userRef = db.collection(USERS_COLLECTION).doc(username);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      username,
      currentInteractions: increment,
      totalInteractions: increment,
    });
  } else {
    const data = userSnap.data()!;
    await userRef.update({
      currentInteractions: (data.currentInteractions || 0) + increment,
      totalInteractions: (data.totalInteractions || 0) + increment,
    });
  }
}

// Helper: Handle return when device is retired
async function handleReturn(deviceID: string, username: string) {
  // Update user
  const userRef = db.collection(USERS_COLLECTION).doc(username);
  const userSnap = await userRef.get();
  if (userSnap.exists) {
    const data = userSnap.data()!;
    await userRef.update({
      currentInteractions: Math.max((data.currentInteractions || 1) - 1, 0),
    });
  }
  // Update interaction (set return date for open interaction)
  const interactionsRef = db.collection(INTERACTIONS_COLLECTION)
    .where('deviceID', '==', deviceID)
    .where('username', '==', username)
    .where('dateOfReturn', '==', null);
  const interactionsSnap = await interactionsRef.get();
  for (const doc of interactionsSnap.docs) {
    await doc.ref.update({ dateOfReturn: new Date().toISOString() });
  }
}

// Usage: node parser.js devices.csv
const csvFile = process.argv[2];
if (!csvFile) {
  console.error('Usage: node parser.js <devices.csv>');
  process.exit(1);
}
importDevicesFromCSV(path.resolve(csvFile)).catch(console.error);