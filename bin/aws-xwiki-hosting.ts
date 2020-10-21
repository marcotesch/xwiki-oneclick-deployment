#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsXwikiHostingStack } from '../lib/aws-xwiki-hosting-stack';

const app = new cdk.App();
new AwsXwikiHostingStack(app, 'AwsXwikiHostingStack', {
  env: {
    region: 'eu-central-1'
  }
});
