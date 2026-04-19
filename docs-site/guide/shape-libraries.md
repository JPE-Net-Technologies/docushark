# Shape Libraries

Diagrammer comes with extensive shape libraries for creating any kind of diagram, plus a large collection of cloud provider icons for architecture diagrams.

## Browsing Shape Libraries

Open the **Shape Picker** from the toolbar:

1. Click the **Shapes** button in the toolbar (or press `S`)
2. Browse categories in the sidebar tabs
3. Click a shape to select it as your current drawing tool
4. Click on the canvas to place the shape

## Built-in Libraries

### Basic Shapes

The foundation shapes available in every document:

| Shape | Description |
|-------|-------------|
| **Rectangle** | Standard rectangular shape with optional rounded corners |
| **Ellipse** | Circles and ellipses |
| **Line** | Straight lines with optional arrowheads |
| **Text** | Text labels with full formatting |
| **Connector** | Smart auto-routing connectors |
| **Group** | Container for organizing shapes |

### Flowchart

Standard flowchart symbols for process diagrams:

| Shape | Usage |
|-------|-------|
| **Decision** | Yes/No branch point (diamond) |
| **Terminator** | Start/End points (rounded rectangle) |
| **Data** | Input/Output (parallelogram) |
| **Document** | Document reference (wavy bottom) |
| **Predefined Process** | Subroutine call (double-sided) |
| **Manual Input** | User input step (trapezoid) |
| **Preparation** | Initialization step (hexagon) |
| **Connector** | On-page connector (circle) |
| **Off-Page Connector** | Off-page reference (pentagon arrow) |

Use a standard **Rectangle** shape for generic process steps.

### UML

Unified Modeling Language shapes for software design:

**Class Diagrams:**
- **Class** — Three-compartment box with attributes and methods
- **Interface** — Interface definition with stereotype
- **Abstract Class** — Abstract class (italicized name)
- **Enumeration** — Enum type
- **Package** — Package container
- **Note** — Dog-eared annotation note

**Use Case Diagrams:**
- **Actor** — Stick figure for users/systems
- **Use Case** — Ellipse for functionality
- **System Boundary** — Rectangle container with title

**Sequence Diagrams:**
- **Lifeline** — Actor/object with dashed vertical line (6 head type variants)
- **Activation** — Execution bar on a lifeline (supports nesting)
- **Fragment** — Interaction frame (loop, alt, opt, par, break, critical)
- **Sequence Actor** — Stick figure variants (person, system, external)
- **Destruction** — X marker for object destruction
- **State Invariant**, **Time Constraint**, **Coregion**, **Continuation**

**Activity Diagrams:**
- **Action** — Rounded rectangle for activity nodes
- **Initial/Final/Flow Final** — Standard UML activity node markers
- **Fork/Join Bar** — Parallel flow synchronization
- **Decision/Merge** — Diamond nodes for branching
- **Send/Receive Signal** — Pentagon shapes for signal handling
- **Swimlane** — Partitioned lanes for organizing activities by actor
- **Object Node**, **Data Store**, **Central Buffer**, **Pins**, and more

### ERD (Entity-Relationship)

Database modeling shapes (Crow's Foot notation):

| Shape | Description |
|-------|-------------|
| **Entity** | Database table (rectangle) |
| **Weak Entity** | Dependent entity (double border) |
| **Attribute** | Column/field (ellipse) |
| **Key Attribute** | Primary key (underlined ellipse) |
| **Relationship** | Association (diamond) |

## Cloud Provider Icons

Diagrammer includes official service icons from major cloud providers, perfect for architecture diagrams:

### AWS Icons

Hundreds of AWS service and resource icons organized into sub-categories:

- **Compute** — EC2, Lambda, ECS, EKS, Fargate, Batch, and more
- **Storage** — S3, EBS, EFS, Glacier
- **Databases** — RDS, DynamoDB, ElastiCache, Redshift
- **Networking** — VPC, CloudFront, Route 53, API Gateway
- **Security** — IAM, KMS, Cognito, WAF
- **Analytics, Containers, AI/ML, DevTools**, and more

### Azure Icons

Official Azure service icons covering:

- Compute, Networking, Databases, Identity, Storage, and many more categories

### GCP Icons

Google Cloud Platform icons for:

- Compute Engine, Cloud Functions, BigQuery, Cloud Storage, Kubernetes Engine, and more

### Other Technology Icons

- **Kubernetes** — Pods, Services, Deployments, Ingress
- **Docker** — Container icons
- **Databases** — PostgreSQL, MySQL, MongoDB, Redis
- **Languages & Frameworks** — Popular programming language and framework logos

::: tip
Cloud icons use brand colors from each provider. They maintain their visual identity in both light and dark themes.
:::

## Custom Shape Libraries

Create your own reusable shape collections.

### Creating a Library

1. Select shapes you want to include
2. Right-click → **Add to Library**
3. Choose an existing library or create a new one
4. Name your shape

### Managing Libraries

Access library management from **Settings → Shape Libraries**:

- **Create** new libraries
- **Rename** existing libraries
- **Delete** libraries (built-in libraries cannot be deleted)
- **Export** libraries as JSON files
- **Import** libraries from JSON files

### Sharing Libraries

Export your custom library:

1. Go to **Settings → Shape Libraries**
2. Select your library
3. Click **Export**
4. Share the `.json` file

Import a shared library:

1. Go to **Settings → Shape Libraries**
2. Click **Import**
3. Select the `.json` file

## Tips

- **Right-click** a shape on canvas → **Save to Library** to add it to a custom library
- After selecting a shape tool from the picker, click on the canvas to place it
- **Use the search** in the shape picker to find icons by name across all libraries
- For styling and theme options, see the [Styling & Themes](./styling) guide
