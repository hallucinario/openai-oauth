# OpenAI OAuth Privacy Policy

Effective date: July 2, 2026

OpenAI OAuth is an unofficial, community-maintained project. It is not affiliated with, endorsed by, or sponsored by OpenAI, Inc.

## Sign in with ChatGPT Extension

The Sign in with ChatGPT browser extension is used only to complete sign-in.

During sign-in, it detects the local OpenAI OAuth callback at `http://localhost:1455/auth/callback`, shows a confirmation screen, and returns you to the app you chose.

The extension temporarily handles the OAuth callback parameters, such as `code` and `state`, and the app URL that started sign-in. This data is stored only in Chrome session storage for the active sign-in flow and is removed when you continue or cancel.

OpenAI OAuth does not receive this data on any OpenAI OAuth server.

## What The Extension Does Not Do

The extension does not read ChatGPT chat history, page contents, browsing history, or passwords.

It does not sell data, use data for ads or analytics, or use data for any purpose unrelated to sign-in.

## Contact

For questions, contact evanzhoudev@gmail.com or open an issue at https://github.com/EvanZhouDev/openai-oauth/issues.