# Documents in the Mobile App (RN-13)

Community document access: browse folders and documents, open files, upload
with progress, cancellation and retry, and rename, archive or delete where
allowed. The backend is Stage 10 (see [`documents.md`](documents.md)):
private bucket, metadata RLS, storage policies, two-phase uploads. **No
migration was needed.**

- **Screens:** `apps/mobile/src/features/documents/screens/`
  - `DocumentsScreen`: folders, then documents (newest first, 20 per page); "Archived" tab for managers; "Upload" for uploaders
  - `DocumentDetailScreen`: type, size, date, access; "Open document"; Rename, Archive / Restore, Delete when allowed
  - `DocumentUploadScreen` (modal): choose a file, check it, name it, upload (progress, cancel, retry, discard)
- **Rules and hooks:**
  - `documentRules.ts`: file checks (type, size), wording, which controls to show
  - `useDocumentList.ts`: keyset pages per folder or view
  - `DocumentItem.tsx`: document and folder rows
- **App plumbing:**
  - `apps/mobile/src/lib/uploader.ts`: XMLHttpRequest transport (byte progress, abort)
  - `apps/mobile/src/lib/media.ts`: `pickDocument()` with `expo-document-picker` (`~57.0.3`, the SDK 57 version)
- **Service additions** (`services/documents`): `uploadRules`, `beginUpload`, `sendFile`, `completeUpload`, `cancelUpload`; `createServices({ uploadFile })` for the transport
- **Tests:**
  - `apps/mobile/src/features/documents/documents.test.tsx` (24)
  - `documentRules.test.ts` (5), `apps/mobile/src/lib/uploader.test.ts` (4)
  - `tests/services/documents-ui.test.ts` (10, real Supabase and Storage)

## Routes

| Route | Where | Notes |
|---|---|---|
| `Documents` `{ folderId?, folderName? }` | community stack | From the hub's "Documents" shortcut; a folder pushes another `Documents` |
| `DocumentDetail` `{ documentId }` | community stack | Also opened from notifications (RN-12) |
| `DocumentUpload` `{ folderId?, folderName? }` | community stack (modal) | Only shown with `documents.upload` |

## Who sees and does what

The app only shows or hides controls. The database decides every read and
write (Stage 10 RLS, trigger and storage policies):

| | Viewer (`documents.view`) | Uploader (`documents.upload`) | Manager (`documents.manage`) |
|---|---|---|---|
| Active documents, visibility "members" | ✓ | ✓ | ✓ |
| "Managers only" and archived documents | – | – | ✓ |
| Upload | – | ✓ | ✓ (may choose "Managers only") |
| Rename, delete | – | own documents | any |
| Archive, restore | – | – | ✓ |

## Upload

```
choose file ──► check type and size (from uploadRules) ──► Upload
  1. beginUpload   create_document_upload: permission, type allow-list, size, folder
                   → document id (pending, invisible to members); the server makes the path
  2. sendFile      reads the pending row (RLS) for its path, type and size;
                   sends the bytes to that path only (storage INSERT policy, no overwrite)
                   progress (XHR upload events); Cancel aborts the transfer
  3. completeUpload complete_document_upload: checks the stored object's real size and type
                   → active; the app opens the new document
```

- **Progress:** "Uploading… N%" with a progress bar (`accessibilityRole="progressbar"` and its value).
- **Cancel** (during the transfer): aborts it, removes any stored file and closes
  the reservation (`cancelUpload`: pending → deleted). Leaving the screen does the same.
- **Failure:** the reason is shown, with "Try again" and "Discard". Retry
  resumes from the failed step and keeps the reservation, so there is never a
  second document. A transfer whose answer was lost (Storage says the file
  already exists) counts as sent.
- **File checks before any request:** supported types come from
  `document_mime_types` (extension first, so `setup.exe` claiming to be a PDF
  is refused), and the limit from `document_upload_settings` (25 MB by
  default). A size the picker does not report is checked after reading.

## Security

- **No permanent URLs.** Files open through a 60-second signed link created
  on demand (`getDownloadUrl`); the bucket is private, and Storage re-checks
  access when the link is made.
- **Nothing from the client is trusted:**
  - the community comes from the current-community context and is checked by the RPC;
  - document ids are read back through RLS;
  - the storage path, stored type and size come from the server's row
    (`sendFile` never takes a path);
  - the file name is display only, sanitised by the database, never part of the path.
- **Cross-community:** list and detail filter to the current community, and the
  database returns nothing from another one. A link to another community's
  document shows "This document is not available".
- **The upload transport** (`lib/uploader.ts`) sends the same Storage request
  as supabase-js: the user's access token, the public anon key, `x-upsert: false`.
  It never chooses the path.
- Tests call the backend directly to show that hidden buttons are not the
  protection: member rename, delete, archive and upload are refused.

## Known limitations

- No folder management (create, rename, move) in the app; folders made by managers elsewhere are browsable.
- No document search, sorting options or offline copies.
- Visibility can only be chosen at upload (no later change in the app).
- Supabase Storage has no resumable upload here; a retry sends the whole file again.
- The XHR transport needs a native or web `XMLHttpRequest` (React Native has one).
- The purge job for deleted and abandoned uploads must be scheduled on the hosted project (Stage 10).
