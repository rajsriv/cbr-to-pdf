# Deploying to Vercel

This project is now configured for deployment on Vercel.

## Steps to Deploy

1.  **Push to GitHub**:
    *   Create a new repository on GitHub.
    *   Push your local code to the GitHub repository:
        ```bash
        git remote add origin <your-github-repo-url>
        git branch -M main
        git push -u origin main
        ```

2.  **Import to Vercel**:
    *   Go to your Vercel Dashboard.
    *   Click **"Add New..."** -> **"Project"**.
    *   Select your GitHub repository.
    *   Vercel should automatically detect the settings.
    *   Click **"Deploy"**.

## Important Notes

*   **File Size Limit**: Vercel Serverless Functions have a request body limit of **4.5MB**.
    *   *Note*: The original 500MB upload limit in `server.js` has been adjusted to **4.5MB** to match Vercel's constraints.
    *   Large files (CBR/CBZ > 4.5MB) **will fail to upload** on the standard Vercel environment.
    *   For larger files, simple deployment to Vercel is not sufficient. You would need to use client-side uploads to a storage service (like AWS S3 or Supabase Storage) or use a hosting provider that supports long-running servers and large uploads (e.g., Render, Railway, Heroku).

*   **Temporary Files**: The application has been updated to use the system's temporary directory (`os.tmpdir()`), which maps to the ephemeral `/tmp` directory on Vercel.

*   **Static Assets**: The `vercel.json` and `server.js` are configured to serve your frontend correctly.
