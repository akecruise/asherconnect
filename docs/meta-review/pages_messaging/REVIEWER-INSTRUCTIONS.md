# Meta pages_messaging Reviewer Instructions

Status: READY — pages_messaging review flow verified.

The reviewer account is restricted to test conversations. The review-code
conversation uses `mode=human`, so the bot does not reply automatically; the
reply is sent from ASHER Connect.

## Credentials

- Username/email: `meta-review@asher.local`
- Password: [PROVIDED SECURELY OUTSIDE REPOSITORY]

Never store the real password, a session cookie, an access token, or a refresh
token in this repository.

## Review flow

1. ส่งข้อความที่ขึ้นต้นด้วย `META-REVIEW` เข้าเพจก่อน แล้วจึง login
2. Open https://inbox.apluscondo.com.
3. Sign in with the reviewer credentials supplied in the Meta App Review form.
4. Open the Messenger inbox and select the resulting test conversation.
5. Confirm that the inbound message is visible.
6. Reply from ASHER Connect. The bot will not reply automatically (`mode=human`).
7. Confirm that the Facebook test account receives the reply from ASHER Connect.

The reviewer must not open any other conversation or any system administration,
user management, production configuration, reporting, or Answer Hub
administration feature.
