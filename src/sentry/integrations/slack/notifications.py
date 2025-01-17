from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from typing import Any

import sentry_sdk
from slack_sdk.errors import SlackApiError

from sentry.integrations.mixins import NotifyBasicMixin
from sentry.integrations.notifications import get_integrations_by_channel_by_recipient
from sentry.integrations.slack.client import SlackClient
from sentry.integrations.slack.service import SlackService
from sentry.integrations.types import ExternalProviders
from sentry.notifications.notifications.base import BaseNotification
from sentry.notifications.notify import register_notification_provider
from sentry.shared_integrations.exceptions import ApiError
from sentry.types.actor import Actor
from sentry.utils import metrics

logger = logging.getLogger("sentry.notifications")
SLACK_TIMEOUT = 5


class SlackNotifyBasicMixin(NotifyBasicMixin):
    def send_message(self, channel_id: str, message: str) -> None:
        payload = {"channel": channel_id, "text": message}
        client = self.get_client()

        if isinstance(client, SlackClient):
            try:
                client.post("/chat.postMessage", data=payload, json=True)
            except ApiError as e:
                message = str(e)
                if message not in ["Expired url", "channel_not_found"]:
                    logger.exception(
                        "slack.slash-notify.response-error",
                        extra={"error": message},
                    )
        else:
            try:
                client.chat_postMessage(channel=channel_id, text=message)
            except SlackApiError as e:
                error = str(e)
                message = error.split("\n")[0]
                if "Expired url" not in message and "channel_not_found" not in message:
                    logger.exception(
                        "slack.slash-response.error",
                        extra={"error": error},
                    )


@register_notification_provider(ExternalProviders.SLACK)
def send_notification_as_slack(
    notification: BaseNotification,
    recipients: Iterable[Actor],
    shared_context: Mapping[str, Any],
    extra_context_by_actor: Mapping[Actor, Mapping[str, Any]] | None,
) -> None:
    """Send an "activity" or "alert rule" notification to a Slack user or team, but NOT to a channel directly.
    Sending Slack notifications to a channel is in integrations/slack/actions/notification.py"""

    service = SlackService.default()
    with sentry_sdk.start_span(
        op="notification.send_slack", description="gen_channel_integration_map"
    ):
        data = get_integrations_by_channel_by_recipient(
            notification.organization, recipients, ExternalProviders.SLACK
        )

    for recipient, integrations_by_channel in data.items():
        with sentry_sdk.start_span(op="notification.send_slack", description="send_one"):
            with sentry_sdk.start_span(op="notification.send_slack", description="gen_attachments"):
                attachments = service.get_attachments(
                    notification,
                    recipient,
                    shared_context,
                    extra_context_by_actor,
                )

            for channel, integration in integrations_by_channel.items():
                service.notify_recipient(
                    notification=notification,
                    recipient=recipient,
                    attachments=attachments,
                    channel=channel,
                    integration=integration,
                    shared_context=shared_context,
                )

    metrics.incr(
        f"{notification.metrics_key}.notifications.sent",
        instance=f"slack.{notification.metrics_key}.notification",
        skip_internal=False,
    )
