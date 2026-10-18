import { PutEventsCommand, EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { HomeRegion } from '@thapsus/core';
import { createAwsClientFactory } from '@thapsus/core/aws';
import type { OutboxEvent } from '@thapsus/db';
import { MemoryPublisher, type EventPublisher } from './engine';

/**
 * Publishes outbox events to the cell's regional EventBridge bus. Only identifiers and topic travel on
 * the bus (no personal data); consumers re-read details from the database inside the tenant context.
 */
export class EventBridgePublisher implements EventPublisher {
  private client: EventBridgeClient;
  constructor(
    cell: HomeRegion,
    private readonly busName: string,
  ) {
    this.client = createAwsClientFactory({ cell })(EventBridgeClient, 'events');
  }
  async publish(events: OutboxEvent[]) {
    for (let i = 0; i < events.length; i += 10) {
      const batch = events.slice(i, i + 10);
      await this.client.send(
        new PutEventsCommand({
          Entries: batch.map((e) => ({
            EventBusName: this.busName,
            Source: 'thapsus-hr',
            DetailType: e.topic,
            Detail: JSON.stringify({ tenantId: e.tenantId, eventId: e.id, aggregateType: e.aggregateType, aggregateId: e.aggregateId }),
          })),
        }),
      );
    }
  }
}

export function publisherFromEnv(cell: HomeRegion, env: NodeJS.ProcessEnv = process.env): EventPublisher {
  return env.EVENT_BUS_NAME ? new EventBridgePublisher(cell, env.EVENT_BUS_NAME) : new MemoryPublisher();
}
