Below is a developer-ready specification document.

---

# Specification Document

## Local PDF Upload, Extraction, and Combined HTML Export Tool

## 1. Purpose

Build a small local application using:

* **React** for the user interface
* **Python** for backend processing

The application must allow the user to upload one or more PDF files, store them in a local folder at:

```text
/sourcedocs
```

Then the application must run a text-extraction process over **all PDF files currently present** in `/sourcedocs`, combine the extracted text into a single output document, and save that output as an HTML file at:

```text
/destination/combined[timestamp].html
```

Each execution creates exactly **one combined HTML file per run**.

---

## 2. Objectives

The system must:

1. Accept uploaded PDF files through a React UI.
2. Save uploaded PDFs to a local backend-managed directory: `/sourcedocs`.
3. Run a Python text extraction process across all PDFs in `/sourcedocs`.
4. Merge the extracted text into one HTML file.
5. Save the generated file into `/destination` using a timestamped filename.
6. Provide the user with visible run status, success/failure feedback, and the path/name of the generated HTML file.

---

## 3. Scope

### In scope

* Local-only application
* Upload PDF files from browser UI
* Save files to disk
* Extract text from PDFs
* Combine extracted text in deterministic order
* Produce one timestamped HTML file per extraction run
* Show processing results in UI

### Out of scope

* OCR for scanned/image-only PDFs unless explicitly added later
* Authentication and user accounts
* Cloud storage
* Multi-user concurrency
* Editing extracted text in UI
* Database integration
* Full document indexing/search engine

---

## 4. Assumptions

1. The application runs on a local machine or controlled internal environment.
2. The Python backend has filesystem access to create and write into:

   * `/sourcedocs`
   * `/destination`
3. Uploaded files are expected to be valid PDFs.
4. Text extraction targets machine-readable PDFs.
5. The UI and backend are run together as one local solution.
6. Output HTML is intended for reading/export, not advanced styling.

---

## 5. High-Level Architecture

## 5.1 Components

### Frontend

* **React application**
* Provides:

  * File upload UI
  * List of selected files
  * Trigger button for upload + processing
  * Progress/status messages
  * Final output file information

### Backend

* **Python service** (recommended: FastAPI)
* Responsible for:

  * Accepting uploaded files
  * Validating PDF type
  * Saving files into `/sourcedocs`
  * Running extraction logic
  * Generating combined HTML
  * Returning result metadata to frontend

### Filesystem

* `/sourcedocs` stores source PDF files
* `/destination` stores generated HTML outputs

---

## 6. Recommended Technology Stack

## 6.1 Frontend

* React
* TypeScript preferred
* Axios or Fetch API for backend communication

## 6.2 Backend

* Python 3.11+
* FastAPI preferred for simplicity and clean API design
* Uvicorn for local server

## 6.3 PDF Text Extraction

Recommended libraries, in this order:

1. **pypdf**
2. **pdfplumber**

Recommended default:

* Use `pdfplumber` first for better extraction quality
* Fall back to `pypdf` if needed

## 6.4 HTML Generation

* Plain Python string templating or Jinja2
* No need for complex templating engine unless formatting grows later

---

## 7. Directory Structure

Recommended project structure:

```text
/project-root
  /frontend
    /src
    package.json
  /backend
    app.py
    extractor.py
    file_service.py
    html_writer.py
    requirements.txt
  /sourcedocs
  /destination
```

If backend is the project root owner, it may resolve directories relative to root.

---

## 8. Functional Requirements

## 8.1 Upload PDFs

The user must be able to select and upload one or more PDF files from the React UI.

### Requirements

* Multiple file upload must be supported.
* Only `.pdf` files are accepted.
* Invalid files must be rejected with a clear message.
* Uploaded files must be saved into `/sourcedocs`.

### Expected behavior

* If `/sourcedocs` does not exist, backend creates it.
* Existing files may be overwritten only if explicitly allowed by implementation choice.
* Preferred behavior: preserve original filename and overwrite only when same filename is uploaded again.

---

## 8.2 Run Extraction

After upload completes, the backend must process **all PDF files currently in `/sourcedocs`**.

### Requirements

* The process must not be limited only to newly uploaded files.
* Every run scans the full `/sourcedocs` folder.
* PDFs are processed in deterministic order.

### Deterministic ordering rule

Recommended order:

1. Sort by filename ascending, case-insensitive

This ensures reproducible combined outputs.

---

## 8.3 Extract Text from PDFs

For each PDF in `/sourcedocs`, the backend must:

1. Open the file
2. Read pages in page-number order
3. Extract textual content
4. Preserve page boundaries in output metadata
5. Continue processing remaining files even if one file fails, unless configured otherwise

### Extraction requirements

* Each file’s extracted content must be kept logically separate in the combined output.
* Empty extraction must be allowed but flagged in output/logging.
* Extraction errors must be recorded in the run result.

---

## 8.4 Generate Combined HTML

At the end of each run, the system must produce one HTML file in `/destination`.

### Output filename format

```text
combined[timestamp].html
```

Recommended concrete format:

```text
combined_YYYYMMDD_HHMMSS.html
```

Example:

```text
combined_20260314_181522.html
```

### Timestamp rules

* Use local system time
* Format must be filesystem-safe
* No spaces or colon characters

---

## 8.5 HTML Output Structure

The generated HTML must contain:

1. Document title
2. Run timestamp
3. Number of PDFs processed
4. Section per PDF
5. Extracted text grouped under the relevant file section
6. Optional extraction summary/errors

### Minimum structure example

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Combined PDF Extraction</title>
</head>
<body>
  <h1>Combined PDF Extraction</h1>
  <p>Run timestamp: 2026-03-14 18:15:22</p>
  <p>Files processed: 3</p>

  <hr />

  <h2>File: invoice1.pdf</h2>
  <pre>... extracted text ...</pre>

  <h2>File: report2.pdf</h2>
  <pre>... extracted text ...</pre>
</body>
</html>
```

### Formatting rules

* Use HTML escaping for extracted text
* Use `<pre>` or CSS `white-space: pre-wrap` to preserve readability
* Include clear separators between documents
* HTML must be valid and viewable directly in browser

---

## 9. User Workflow

## 9.1 Primary flow

1. User opens React application
2. User selects one or more PDF files
3. UI shows selected file names
4. User clicks a button such as **Upload and Process**
5. Frontend uploads files to backend
6. Backend saves PDFs into `/sourcedocs`
7. Backend scans all PDFs in `/sourcedocs`
8. Backend extracts text from all PDFs
9. Backend generates `/destination/combined[timestamp].html`
10. Backend returns result to frontend
11. Frontend displays:

* success/failure
* processed file count
* output filename/path
* extraction warnings if any

---

## 10. Backend API Specification

Recommended minimal API design:

## 10.1 `POST /api/upload-and-process`

### Purpose

Upload selected PDFs, save them, process all PDFs in `/sourcedocs`, and generate combined HTML.

### Request

`multipart/form-data`

Field:

* `files`: one or more PDF files

### Response

```json
{
  "success": true,
  "message": "Processing completed",
  "source_directory": "/sourcedocs",
  "destination_file": "/destination/combined_20260314_181522.html",
  "processed_files": 5,
  "uploaded_files": 2,
  "failed_files": [],
  "warnings": []
}
```

### Error response example

```json
{
  "success": false,
  "message": "No valid PDF files supplied",
  "processed_files": 0,
  "uploaded_files": 0,
  "failed_files": [],
  "warnings": ["Only .pdf files are accepted"]
}
```

---

## 11. Backend Processing Logic

## 11.1 Save uploaded files

* Validate extension and MIME type where possible
* Save each file into `/sourcedocs`

## 11.2 Scan source directory

* Read all `.pdf` files from `/sourcedocs`
* Sort filenames ascending

## 11.3 Extract text

For each file:

* Open PDF
* Loop through pages
* Extract text per page
* Concatenate page text into file-level text block

## 11.4 Build combined HTML

* Create document header
* Append section for each file
* Escape text safely
* Save file into `/destination`

## 11.5 Return result metadata

* Generated filename
* Number of PDFs processed
* List of failures/warnings

---

## 12. Error Handling Requirements

The system must handle the following cases gracefully.

## 12.1 Invalid upload type

* Reject non-PDF files
* Return clear validation message

## 12.2 Missing directories

* Auto-create `/sourcedocs` and `/destination` if missing

## 12.3 Corrupted PDF

* Record file as failed
* Continue processing remaining PDFs where possible

## 12.4 Empty source folder

If no valid PDFs exist in `/sourcedocs`, backend must:

* not crash
* return a meaningful message
* preferably not create an empty output unless explicitly desired

Recommended behavior:

* return warning and do not generate output

## 12.5 Extraction returns no text

* File still appears in output
* Mark section as:
  `"No text extracted"` or similar

---

## 13. Non-Functional Requirements

## 13.1 Performance

* Must handle small batches efficiently
* Initial target: 1 to 50 PDFs of moderate size
* UI should remain responsive during processing

## 13.2 Reliability

* One failed PDF must not abort entire run unless a fatal backend error occurs

## 13.3 Maintainability

* Extraction logic must be separated from API layer
* HTML generation must be in its own module
* File handling must be centralized

## 13.4 Usability

* UI must be simple and require minimal clicks
* User should clearly understand:

  * what files were uploaded
  * whether processing succeeded
  * where output was written

## 13.5 Security

* No arbitrary path writing from user input
* Sanitize filenames
* Do not allow path traversal
* Only save into approved local folders

---

## 14. Frontend Specification

## 14.1 Main screen elements

The React UI should contain:

1. Page title
2. File picker with multiple selection enabled
3. Visible list of selected files
4. Primary action button:

   * `Upload and Process`
5. Status area
6. Result area

## 14.2 UI states

### Idle

* No files selected
* Button disabled or enabled depending on UX choice

### Files selected

* Show filenames and count
* Enable action button

### Uploading/processing

* Disable repeated submission
* Show progress message such as:

  * `Uploading files...`
  * `Processing PDFs...`

### Success

* Show:

  * output filename
  * processed file count
  * warnings if any

### Error

* Show clear backend error message

---

## 15. Suggested HTML Output Content Model

Each combined HTML file should include:

### Header section

* Title: Combined PDF Extraction
* Run timestamp
* Source folder path
* Output file path
* Number of files processed

### Per-file section

* Filename
* Optional file size
* Optional extraction status
* Extracted content

### Footer section

* Summary of failed files
* Summary of warnings

---

## 16. Suggested Python Module Design

## 16.1 `app.py`

Responsibilities:

* FastAPI app setup
* API endpoint definitions
* request validation
* response handling

## 16.2 `file_service.py`

Responsibilities:

* create directories
* sanitize filenames
* save uploaded files
* enumerate PDFs in `/sourcedocs`

## 16.3 `extractor.py`

Responsibilities:

* open PDFs
* extract text page by page
* return structured extraction result

Suggested result model:

```python
{
    "filename": "example.pdf",
    "success": True,
    "text": "extracted text...",
    "page_count": 8,
    "warning": None,
    "error": None
}
```

## 16.4 `html_writer.py`

Responsibilities:

* transform extraction results into final HTML
* escape content safely
* write final file to `/destination`

---

## 17. Suggested React Component Design

## 17.1 `App`

Main container

## 17.2 `FileUploader`

Handles file selection

## 17.3 `SelectedFileList`

Displays chosen files

## 17.4 `RunStatus`

Shows current processing state

## 17.5 `RunResult`

Displays success/failure and generated filename

---

## 18. Data and Naming Rules

## 18.1 Source files

* Keep original filename where safe
* Sanitize unsafe characters if needed

## 18.2 Output files

Must follow:

```text
combined_YYYYMMDD_HHMMSS.html
```

## 18.3 Encoding

* Use UTF-8 for extracted text and output HTML

---

## 19. Acceptance Criteria

The feature is complete only if all of the following are true:

1. User can upload one or more PDFs from the React UI.
2. Uploaded PDFs are saved into `/sourcedocs`.
3. Backend scans **all** PDFs in `/sourcedocs`, not just newly uploaded ones.
4. Text extraction runs successfully for valid machine-readable PDFs.
5. One HTML file is generated per run in `/destination`.
6. Output filename includes a timestamp.
7. Combined HTML includes distinct sections for each PDF.
8. Frontend displays the result of the run clearly.
9. Invalid or corrupted PDFs are handled gracefully.
10. Required directories are auto-created when missing.

---

## 20. Future Enhancements

Not required for first version, but recommended later:

* OCR support for scanned PDFs
* Download button for generated HTML
* Run history list
* Preview of extracted content in UI
* Duplicate file detection
* Option to clear `/sourcedocs`
* Option to process only newly uploaded files
* Metadata extraction such as page count and title

---

## 21. Implementation Notes

Recommended processing rule for first version:

* Upload files
* Save them to `/sourcedocs`
* Immediately process every PDF in `/sourcedocs`
* Produce a new combined HTML output every time

This keeps behavior simple, predictable, and easy to test.

---

## 22. Optional Developer Clarifications to Resolve During Build

Since the requested behavior is mostly clear, only these implementation decisions need to be fixed by the team:

1. Whether same-name uploads overwrite existing files or get renamed
2. Whether an output HTML should still be generated when no text is extracted
3. Whether the UI should expose the full file path or only filename
4. Whether per-file extraction failures should appear inside HTML output, API response only, or both

---

## 23. Short Developer Summary

Build a local React + Python application where the user uploads PDFs, backend stores them in `/sourcedocs`, backend processes every PDF in that folder, extracts text, combines results, and writes one timestamped HTML file to `/destination/combined_YYYYMMDD_HHMMSS.html`.

(شمول 96% ثقة 94% حاجة إلى معلومات إضافية 18%)
