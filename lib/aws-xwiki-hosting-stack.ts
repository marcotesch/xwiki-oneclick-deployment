import * as cdk from '@aws-cdk/core';
import { FileSystem, PerformanceMode } from '@aws-cdk/aws-efs';
import { CfnSecurityGroup, DefaultInstanceTenancy, InstanceType, NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc, VpcLookupOptions } from '@aws-cdk/aws-ec2';
import { Key } from '@aws-cdk/aws-kms';
import { AuroraCapacityUnit, AuroraMysqlEngineVersion, AuroraPostgresEngineVersion, DatabaseCluster, DatabaseClusterEngine, ServerlessCluster, SubnetGroup } from '@aws-cdk/aws-rds';
import { AwsLogDriver, Cluster, ContainerImage, FargatePlatformVersion, FargateService, FargateTaskDefinition, Secret as EcsSecret } from '@aws-cdk/aws-ecs';
import { IHostedZone, PrivateHostedZone } from '@aws-cdk/aws-route53';
import { CfnLogGroup, LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { ManagedPolicy, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { Secret } from '@aws-cdk/aws-secretsmanager';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup } from '@aws-cdk/aws-elasticloadbalancingv2';
import { CfnOutput } from '@aws-cdk/core';

export interface AwsXwikiHostingStackProps extends cdk.StackProps {
};

export class AwsXwikiHostingStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: AwsXwikiHostingStackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const xwikiVpc = new Vpc(this, 'trcVpc', {
      cidr: '10.42.42.0/24',
      defaultInstanceTenancy: DefaultInstanceTenancy.DEFAULT,
      maxAzs: 2,
      natGatewayProvider: NatProvider.gateway(),
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 27
        },
        {
          name: 'private-database',
          subnetType: SubnetType.PRIVATE,
          cidrMask: 26
        }
      ]
    });

    const xwikiEncryptionKey = new Key(this, 'trcXWikiEncryptionKey', {
      alias: `trc-xwiki`,
      description: `Encryption Key for XWiki Storage Resources`,
      enableKeyRotation: true,
      enabled: true,
      trustAccountIdentities: true,
    });

    const xwikiSecretEncryptionKey = new Key(this, 'trcXWikiSecretEncryptionKey', {
      alias: `trc-xwiki-secret`,
      description: `Encryption Key for XWiki Secrets`,
      enableKeyRotation: true,
      enabled: true,
      trustAccountIdentities: true,
    });

    const xwikiEfsSg = new SecurityGroup(this, 'trcXWikiEfsSecurityGroup', {
      vpc: xwikiVpc,
      allowAllOutbound: true,
      description: `Security Group for XWiki EFS`
    });

    const xwikiEfs = new FileSystem(this, 'trcXWikiFileSystem', {
      vpc: xwikiVpc,
      enableAutomaticBackups: true,
      encrypted: true,
      kmsKey: xwikiEncryptionKey,
      performanceMode: PerformanceMode.GENERAL_PURPOSE,
      securityGroup: xwikiEfsSg,
      vpcSubnets: xwikiVpc.selectSubnets(
        {
          subnetType: SubnetType.PRIVATE
        }
      )
    });

    const xwikiRdsSg = new SecurityGroup(this, 'trcXWikiRdsSecurityGroup', {
      vpc: xwikiVpc,
      allowAllOutbound: true,
      description: `Security Group for XWiki RDS`
    });

    const xwikiRdsDbSubnetGroup = new SubnetGroup(this, 'trcXWikiDbSubnetGroup', {
      description: `DB SubnetGroup for XWiki RDS`,
      vpc: xwikiVpc,
      vpcSubnets: xwikiVpc.selectSubnets(
        {
          subnetType: SubnetType.PRIVATE
        }
      )
    });

    const xwikiRdsPwSecret = new Secret(this, 'trcXWikiEcsUserPassword', {
      description: `RDS UserSecret for XWiki RDS`,
      encryptionKey: xwikiSecretEncryptionKey,
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 16
      }
    });

    const xwikiRds = new ServerlessCluster(this, 'trcXWikiDbCluster', {
      engine: DatabaseClusterEngine.auroraMysql({
        version: AuroraMysqlEngineVersion.VER_2_07_1
      }),
      vpc: xwikiVpc,
      vpcSubnets: xwikiVpc.selectSubnets(
        {
          subnetType: SubnetType.PRIVATE
        }
      ),
      credentials: {
        username: 'xwikimysql',
        password: xwikiRdsPwSecret.secretValue,
      },
      backupRetention: cdk.Duration.days(7),
      scaling: {
        autoPause: cdk.Duration.minutes(0), // AutoPause Disabled
        minCapacity: AuroraCapacityUnit.ACU_1,
        maxCapacity: AuroraCapacityUnit.ACU_8
      },
      securityGroups: [
        xwikiRdsSg
      ],
      defaultDatabaseName: 'xwiki',
      storageEncryptionKey: xwikiEncryptionKey,
      subnetGroup: xwikiRdsDbSubnetGroup
    });

    const xwikiFargateCluster = new Cluster(this, 'trcXWikiCluster', {
      containerInsights: true,
      vpc: xwikiVpc
    });

    const xwikiTaskIamRole = new Role(this, 'trcXwikiTaskRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `IAM Task Role for XWiki ECS Fargate`,
    });

    const xwikiTaskDefinition = new FargateTaskDefinition(this, 'trcXWikiTaskDefinition', {
      cpu: 2048,
      memoryLimitMiB: 4096,
      volumes: [
        {
          name: 'EfsPersistendVolume',
          efsVolumeConfiguration: {
            fileSystemId: xwikiEfs.fileSystemId,
            rootDirectory: '/',
            transitEncryption: 'ENABLED'
          }
        }
      ],
      executionRole: xwikiTaskIamRole,
      taskRole: xwikiTaskIamRole
    });

    const xwikiLogGroup = new LogGroup(this, 'trcXWikiLogGroup', {
      retention: RetentionDays.ONE_MONTH
    });

    xwikiLogGroup.grantWrite(xwikiTaskIamRole);

    const xwikiContainer = xwikiTaskDefinition.addContainer('XWikiImage', {
      image: ContainerImage.fromRegistry('xwiki:12.8-mysql-tomcat'),
      environment: {
        'DB_HOST': xwikiRds.clusterEndpoint.hostname,
        'DB_DATABASE': 'xwiki',
        'DB_USER': 'xwikimysql'
      },
      logging: new AwsLogDriver({
        logGroup: xwikiLogGroup,
        streamPrefix: `trc-xwiki`
      }),
      secrets: {
        'DB_PASSWORD': EcsSecret.fromSecretsManager(xwikiRdsPwSecret)
      },
      essential: true,
    });

    xwikiContainer.addPortMappings({
      containerPort: 8080
    });

    xwikiContainer.addMountPoints({
      containerPath: '/usr/local/xwiki/data',
      readOnly: false,
      sourceVolume: 'EfsPersistendVolume'
    });

    const xwikiServiceSecurityGroup = new SecurityGroup(this, 'trcXWikiTaskSecurityGroup', {
      vpc: xwikiVpc,
      allowAllOutbound: true,
      description: `SecurityGroup for XWiki ECS Fargate Service`
    });

    const xwikiLoadBalancerSecurityGroup = new SecurityGroup(this, 'trcXWikiAlbSecurityGroup', {
      vpc: xwikiVpc,
      allowAllOutbound: true,
      description: `SecurityGroup for XWiki Application LoadBalancer`
    });

    xwikiLoadBalancerSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80),
      `Allow HTTP Connections for the World to Application LoadBalancer`
    );

    const xwikiLoadBalancer = new ApplicationLoadBalancer(this, 'trcXWikiLoadBalancer', {
      vpc: xwikiVpc,
      internetFacing: true,
      securityGroup: xwikiLoadBalancerSecurityGroup
    });

    const xwikiLoadBalancerListener = xwikiLoadBalancer.addListener('trcXWikiLoadBalancerHttpListener', {
      protocol: ApplicationProtocol.HTTP,
    });

    xwikiServiceSecurityGroup.addIngressRule(
      xwikiLoadBalancerSecurityGroup,
      Port.tcp(8080),
      `Allow HTTP Connections for XWiki ECS Application LoadBalancer`
    );

    xwikiEfsSg.addIngressRule(
      xwikiServiceSecurityGroup,
      Port.tcp(2049),
      `Allow NFS Connection for XWiki Service`
    );

    xwikiRdsSg.addIngressRule(
      xwikiServiceSecurityGroup,
      Port.tcp(xwikiRds.clusterEndpoint.port),
      `Allow DB Connection for XWiki Service`
    );

    const xwikiEcsService = new FargateService(this, 'trcXWikiService', {
      cluster: xwikiFargateCluster,
      taskDefinition: xwikiTaskDefinition,
      desiredCount: 1,
      platformVersion: FargatePlatformVersion.VERSION1_4,
      vpcSubnets: xwikiVpc.selectSubnets(
        {
          subnetType: SubnetType.PRIVATE
        }
      ),
      securityGroups: [
        xwikiServiceSecurityGroup
      ]
    });

    xwikiLoadBalancerListener.addTargets('trcXWikiTargets', {
      deregistrationDelay: cdk.Duration.minutes(1),
      protocol: ApplicationProtocol.HTTP,
      targets: [
        xwikiEcsService
      ],
      healthCheck: {
        healthyHttpCodes: '200,301,302'
      }
    });

    new CfnOutput(this, 'trcXWikiLoadBalancerDns', {
      value: xwikiLoadBalancer.loadBalancerDnsName,
      description: `DNS Endpoint for connecting to the XWiki Installation`
    });

  }
}