# FirestoreParser

A Node.js/TypeScript tool for importing and synchronizing device inventory data from a CSV (exported from Excel or Google Sheets) into a Firestore backend.  
This parser is designed for managing physical device checkouts, user interactions, and device status updates in a storage management system.

---

## Features

- **Imports devices from CSV**: Adds new devices and updates existing ones in Firestore.
- **Attribute validation**: Only allows changes to permitted fields; deviceID, deviceName, and deviceType are immutable.
- **User and interaction management**: Updates user stats and creates interactions for new device checkouts.
- **Retired device handling**: Marks devices as retired and processes returns if necessary.
- **Change tracking**: Logs all changes, warnings, and errors to the console.
- **DeviceUpdates collection**: Saves a snapshot of the device collection and run summary after each import, with incrementing update numbers.
- **Test mode**: Easily switch between test and production Firestore collections.

---

## Setup

1. **Clone the repository and install dependencies:**

   ```sh
   git clone <your-repo-url>
   cd FirestoreParser
   npm install
   ```

2. **Add your Firebase service account:**

   - Download your `serviceAccountKey.json` from the Google Cloud Console.
   - Place it in the project root.
   - **Never commit this file to version control!**

3. **Prepare your CSV file:**

   - Ensure it has the following columns:  
     `Publisher`, `Model`, `Device Type`, `OS`, `OS Version`, `Inventory Number`, `Sticker-Number (iOS)`, `Checked out by?`, `ID`, `Retired?`
   - `ID`, `Model`, and `Device Type` are mandatory for each row.

4. **Configure collection names:**

   - In `parser.ts`, set the collection constants at the top to use either test or production collections.

5. **Run the parser:**

   ```sh
   npx ts-node parser.ts devices.csv
   ```
   Or use the npm script if configured:
   ```sh
   npm start
   ```

---

## Usage Notes

- **Skipped rows:** Any row missing `ID`, `Model`, or `Device Type` will be skipped with a warning.
- **Immutable fields:** Changes to `deviceID`, `deviceName`, `deviceType`, or `currentUser` for existing devices are not allowed and will be logged as warnings.
- **Device retirement:** If a device is marked as retired and has a current user, the parser will process the return and update user/interactions accordingly.
- **DeviceUpdates collection:** After each run, a document is created with a snapshot and summary. The document name is `UpdateXXXX` (e.g., `Update0004`).

---

## Development

- Written in TypeScript.
- Uses `firebase-admin` for Firestore access and `csv-parse` for CSV parsing.
- See `package.json` for dependencies.


---

**Warning:**  
Do not commit your `serviceAccountKey.json` or any sensitive credentials to your repository.
