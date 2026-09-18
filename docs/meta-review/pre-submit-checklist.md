# Meta App Review — Pre-Submit Checklist

Do not submit until every required item below has passed.

## Application

- [ ] https://inbox.apluscondo.com opens successfully
- [ ] Reviewer login works
- [ ] Reviewer account is test-only
- [ ] No real customer conversations are visible

## Reviewer isolation

- [ ] Conversation list shows only test conversations
- [ ] Conversation detail rejects non-test conversations
- [ ] Message history rejects non-test conversations
- [ ] Send action rejects non-test conversations
- [ ] Queue/count endpoints do not expose production data
- [ ] Reports do not expose production data
- [ ] Bot/system status does not leak sensitive production information

## Messenger

- [ ] Test account can send a Messenger message
- [ ] Webhook receives the message
- [ ] Conversation appears in APLUS Connect
- [ ] Messenger user's display name is visible
- [ ] Staff reply reaches Messenger

## Public documentation

- [ ] Privacy Policy returns HTTP 200
- [ ] Privacy Policy contains no placeholders
- [ ] Data Deletion Instructions are visible
- [ ] https://inbox.apluscondo.com/privacy#data-deletion works

## Meta Dashboard

- [ ] App information complete
- [ ] Correct Page connected
- [ ] Callback URL correct
- [ ] Required permissions selected
- [ ] Use-case text added
- [ ] Reviewer instructions added
- [ ] Reviewer credentials added securely in the review form

## Screencast

- [ ] Video is 1–3 minutes
- [ ] Shows incoming Messenger message
- [ ] Shows APLUS Connect conversation
- [ ] Shows sender display name
- [ ] Shows outgoing reply
- [ ] No secret/token/password visible
- [ ] No real customer conversation visible

## Final

- [ ] Automated preflight PASS
- [ ] Manual reviewer isolation test PASS
- [ ] Production customer data remains inaccessible to reviewer
- [ ] Ready for Meta App Review submission
